import { AppError, upstreamError } from './errors';

const BLOCK_BYTES = 64 * 1024;

interface Entry {
  key: string;
  owner: string;
  controller: AbortController;
  headers: Promise<{ status: number; headers: Headers }>;
  blocks: Buffer[];
  bytes: number;
  charge: number;
  readers: number;
  complete: boolean;
  error?: unknown;
  expiresAt: number;
  wake: Set<() => void>;
}

export interface MediaCacheOptions {
  maxBytes: number;
  maxResourceBytes: number;
  maxFetches: number;
  timeoutMs: number;
  ttlMs: number;
}

/** Bounded replay buffers: no ReadableStream.tee() queues for slow viewers. */
export class MediaCache {
  private readonly entries = new Map<string, Entry>();
  private reservedBytes = 0;
  private fetching = 0;

  constructor(private readonly options: MediaCacheOptions) {}

  private remove(entry: Entry): void {
    if (this.entries.get(entry.key) !== entry) return;
    this.entries.delete(entry.key);
    this.reservedBytes -= entry.charge;
    entry.blocks = [];
  }

  private makeRoom(): void {
    for (const entry of this.entries.values()) {
      if (entry.complete && entry.readers === 0 &&
          (entry.expiresAt <= Date.now() || this.reservedBytes + this.options.maxResourceBytes > this.options.maxBytes || this.entries.size >= 1024)) {
        this.remove(entry);
      }
    }
    if (this.fetching >= this.options.maxFetches ||
        this.reservedBytes + this.options.maxResourceBytes > this.options.maxBytes || this.entries.size >= 1024) {
      throw new AppError(503, 'media_capacity', 'Media transfer capacity reached, try again later');
    }
  }

  async open(owner: string, key: string, fetcher: (signal: AbortSignal) => Promise<Response>, signal: AbortSignal) {
    signal.throwIfAborted();
    let entry = this.entries.get(key);
    if (entry && (entry.error || (entry.complete && entry.expiresAt <= Date.now()))) {
      // Do not replace a buffer still held by slow readers: it must stay accounted for.
      if (!entry.complete || entry.readers !== 0) throw new AppError(503, 'media_capacity', 'Media resource is still in use, try again later');
      this.remove(entry);
      entry = undefined;
    }
    if (!entry) {
      this.makeRoom();
      entry = {
        key, owner, controller: new AbortController(), headers: undefined!, blocks: [], bytes: 0,
        charge: this.options.maxResourceBytes, readers: 0, complete: false, expiresAt: Infinity, wake: new Set(),
      };
      this.reservedBytes += entry.charge;
      this.fetching += 1;
      this.entries.set(key, entry);
      entry.headers = this.pump(entry, fetcher);
      // Every subscriber may disconnect before headers arrive.
      void entry.headers.catch(() => {});
    }
    const current = entry;
    // Refresh LRU position, including completed cache hits.
    this.entries.delete(key);
    this.entries.set(key, current);
    current.readers += 1;
    let released = false;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener('abort', abort);
      current.readers -= 1;
      if (current.readers === 0) {
        if (!current.complete) current.controller.abort();
        else if (current.error || current.expiresAt <= Date.now()) this.remove(current);
      }
    };
    const abort = () => {
      output?.error(signal.reason);
      release();
      for (const wake of current.wake) wake();
    };
    signal.addEventListener('abort', abort, { once: true });
    let metadata;
    try {
      metadata = await withAbort(current.headers, signal);
      signal.throwIfAborted();
    } catch (error) {
      release();
      throw error;
    }
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
      async pull(controller) {
        while (!released) {
          if (current.error) { controller.error(current.error); release(); return; }
          if (offset < current.bytes) {
            const blockIndex = Math.floor(offset / BLOCK_BYTES);
            const within = offset % BLOCK_BYTES;
            const end = Math.min(BLOCK_BYTES, within + current.bytes - offset);
            controller.enqueue(current.blocks[blockIndex]!.subarray(within, end));
            offset += end - within;
            return;
          }
          if (current.complete) { controller.close(); release(); return; }
          await new Promise<void>((resolve) => {
            const wake = () => { current.wake.delete(wake); resolve(); };
            current.wake.add(wake);
          });
        }
      },
      cancel() { release(); },
    }, { highWaterMark: 0 });
    return { ...metadata, body, release };
  }

  private async pump(entry: Entry, fetcher: (signal: AbortSignal) => Promise<Response>) {
    let timer: NodeJS.Timeout;
    const resetTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => entry.controller.abort(new Error('Upstream media timed out')), this.options.timeoutMs);
      timer.unref();
    };
    const wake = () => { for (const fn of entry.wake) fn(); };
    const fail = (error: unknown) => { entry.error = error; wake(); };
    entry.controller.signal.addEventListener('abort', () => fail(upstreamError('Media transfer was cancelled or timed out')), { once: true });
    const finish = () => {
      clearTimeout(timer);
      entry.complete = true;
      entry.expiresAt = Date.now() + this.options.ttlMs;
      this.fetching -= 1;
      const charge = entry.blocks.length * BLOCK_BYTES;
      this.reservedBytes -= entry.charge - charge;
      entry.charge = charge;
      wake();
      if (entry.readers === 0 && (entry.error || this.options.ttlMs === 0)) this.remove(entry);
    };
    resetTimeout();
    let response: Response | undefined;
    try {
      response = await fetcher(entry.controller.signal);
      if (!response.ok && response.status !== 416) throw upstreamError('Jellyfin could not provide the requested resource');
      if (Number(response.headers.get('content-length')) > this.options.maxResourceBytes) {
        throw upstreamError('The upstream media resource exceeds the configured size limit');
      }
      entry.controller.signal.throwIfAborted();
    } catch (error) {
      entry.controller.abort();
      await response?.body?.cancel().catch(() => {});
      fail(error);
      finish();
      throw error;
    }
    resetTimeout();
    const reader = response.body?.getReader();
    // Pump independently of viewer speed; all retained bytes have a reservation.
    void (async () => {
      try {
        if (reader) {
          while (true) {
            const { done, value } = await withAbort(reader.read(), entry.controller.signal);
            entry.controller.signal.throwIfAborted();
            if (done) break;
            resetTimeout();
            if (entry.bytes + value.byteLength > this.options.maxResourceBytes) {
              throw upstreamError('The upstream media resource exceeds the configured size limit');
            }
            let source = 0;
            while (source < value.byteLength) {
              const index = Math.floor(entry.bytes / BLOCK_BYTES);
              const within = entry.bytes % BLOCK_BYTES;
              if (!entry.blocks[index]) entry.blocks.push(Buffer.allocUnsafe(BLOCK_BYTES));
              const count = Math.min(BLOCK_BYTES - within, value.byteLength - source);
              entry.blocks[index]!.set(value.subarray(source, source + count), within);
              source += count;
              entry.bytes += count;
            }
            wake();
          }
        }
      } catch (error) {
        fail(error);
        entry.controller.abort();
        await reader?.cancel().catch(() => {});
      } finally {
        reader?.releaseLock();
        finish();
      }
    })();
    return { status: response.status, headers: new Headers(response.headers) };
  }

  invalidate(owner: string): void {
    for (const entry of this.entries.values()) {
      if (entry.owner !== owner) continue;
      entry.error = upstreamError('Playback session ended');
      entry.controller.abort();
      for (const wake of entry.wake) wake();
      if (entry.complete && entry.readers === 0) this.remove(entry);
    }
  }
}

export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
