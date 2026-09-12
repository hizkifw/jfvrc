import type {
  ApiErrorBody,
  CreateLinkRequest,
  CreateLinkResponse,
  ItemDetails,
  LibraryResponse,
  LinkSummary,
  MediaItem,
  StatusResponse,
} from './types';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

let adminToken = '';
let onUnauthorized: (() => void) | null = null;

export function setAdminToken(token: string): void {
  adminToken = token;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (adminToken) headers.set('Authorization', `Bearer ${adminToken}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError('network_error', 'Could not reach the server. Check your connection.', 0);
  }

  if (response.status === 401) {
    onUnauthorized?.();
    throw new ApiError('unauthorized', 'Your admin token was rejected. Enter it again.', 401);
  }

  if (!response.ok) {
    let code = 'http_error';
    let message = `Request failed (HTTP ${response.status}).`;
    try {
      const body = (await response.json()) as Partial<ApiErrorBody>;
      if (body?.error?.code) code = body.error.code;
      if (body?.error?.message) message = body.error.message;
    } catch {
      // keep generic message when the body is not JSON
    }
    throw new ApiError(code, message, response.status);
  }

  if (response.status === 204) return undefined as unknown as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await response.json()) as T;
  }
  return undefined as unknown as T;
}

function jsonBody(value: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(value) };
}

export const api = {
  health(): Promise<{ status: string }> {
    return request('/health');
  },

  status(): Promise<StatusResponse> {
    return request('/api/status');
  },

  resolve(input: string): Promise<ItemDetails> {
    return request('/api/resolve', jsonBody({ input }));
  },

  library(query: string, startIndex: number, limit: number): Promise<LibraryResponse> {
    const params = new URLSearchParams({
      query,
      startIndex: String(startIndex),
      limit: String(limit),
    });
    return request(`/api/library?${params.toString()}`);
  },

  item(id: string): Promise<ItemDetails> {
    return request(`/api/items/${encodeURIComponent(id)}`);
  },

  createLink(payload: CreateLinkRequest): Promise<CreateLinkResponse> {
    return request('/api/links', jsonBody(payload));
  },

  listLinks(): Promise<{ links: LinkSummary[] }> {
    return request('/api/links');
  },

  revokeLink(id: string): Promise<void> {
    return request(`/api/links/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
};

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function errorMessage(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export function itemLabel(item: MediaItem): string {
  const parts: string[] = [];
  if (item.type === 'Episode') {
    const series = item.seriesName ?? 'Unknown series';
    const season = item.seasonNumber !== undefined ? `S${item.seasonNumber}` : 'S?';
    const episode = item.episodeNumber !== undefined ? `E${item.episodeNumber}` : 'E?';
    parts.push(`${series} ${season}${episode}`);
  } else {
    parts.push(item.name);
  }
  if (item.year) parts.push(`(${item.year})`);
  return parts.join(' · ');
}
