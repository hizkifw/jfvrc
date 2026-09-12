import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LinkSummary, MediaItem, Preset } from '../shared/contracts';

export interface LinkRecord {
  id: string;
  item: MediaItem;
  mediaSourceId: string;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number;
  preset: Preset;
  startSeconds: number;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

export interface NewLink {
  item: MediaItem;
  mediaSourceId: string;
  audioStreamIndex: number | null;
  subtitleStreamIndex: number;
  preset: Preset;
  startSeconds: number;
  expiresAt: string;
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface LinkRow {
  id: string;
  item_json: string;
  media_source_id: string;
  audio_stream_index: number | null;
  subtitle_stream_index: number;
  preset: string;
  start_seconds: number;
  created_at: string;
  expires_at: string;
  revoked: number;
}

function rowToRecord(row: LinkRow): LinkRecord {
  return {
    id: row.id,
    item: JSON.parse(row.item_json) as MediaItem,
    mediaSourceId: row.media_source_id,
    audioStreamIndex: row.audio_stream_index,
    subtitleStreamIndex: row.subtitle_stream_index,
    preset: row.preset as Preset,
    startSeconds: row.start_seconds,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revoked: row.revoked !== 0,
  };
}

export class LinkStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    if (databasePath !== ':memory:' && !databasePath.startsWith('file:')) {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS links (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        item_id TEXT NOT NULL,
        item_json TEXT NOT NULL,
        media_source_id TEXT NOT NULL,
        audio_stream_index INTEGER,
        subtitle_stream_index INTEGER NOT NULL,
        preset TEXT NOT NULL,
        start_seconds REAL NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_links_token_hash ON links(token_hash);
      CREATE INDEX IF NOT EXISTS idx_links_created_at ON links(created_at);
    `);
  }

  createLink(newLink: NewLink): { record: LinkRecord; token: string } {
    const id = randomUUID();
    const token = generateToken();
    const createdAt = new Date().toISOString();
    const record: LinkRecord = {
      id,
      item: newLink.item,
      mediaSourceId: newLink.mediaSourceId,
      audioStreamIndex: newLink.audioStreamIndex,
      subtitleStreamIndex: newLink.subtitleStreamIndex,
      preset: newLink.preset,
      startSeconds: newLink.startSeconds,
      createdAt,
      expiresAt: newLink.expiresAt,
      revoked: false,
    };
    this.db
      .prepare(
        `INSERT INTO links (
          id, token_hash, item_id, item_json, media_source_id, audio_stream_index,
          subtitle_stream_index, preset, start_seconds, created_at, expires_at, revoked
        ) VALUES (
          @id, @tokenHash, @itemId, @itemJson, @mediaSourceId, @audioStreamIndex,
          @subtitleStreamIndex, @preset, @startSeconds, @createdAt, @expiresAt, 0
        )`,
      )
      .run({
        id,
        tokenHash: hashToken(token),
        itemId: record.item.id,
        itemJson: JSON.stringify(record.item),
        mediaSourceId: record.mediaSourceId,
        audioStreamIndex: record.audioStreamIndex,
        subtitleStreamIndex: record.subtitleStreamIndex,
        preset: record.preset,
        startSeconds: record.startSeconds,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      });
    return { record, token };
  }

  findByToken(token: string): LinkRecord | null {
    const row = this.db
      .prepare('SELECT * FROM links WHERE token_hash = ?')
      .get(hashToken(token)) as LinkRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findById(id: string): LinkRecord | null {
    const row = this.db.prepare('SELECT * FROM links WHERE id = ?').get(id) as LinkRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(): LinkRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM links ORDER BY created_at DESC')
      .all() as LinkRow[];
    return rows.map(rowToRecord);
  }

  revoke(id: string): boolean {
    const result = this.db.prepare('UPDATE links SET revoked = 1 WHERE id = ?').run(id);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

export function toLinkSummary(record: LinkRecord): LinkSummary {
  return {
    id: record.id,
    title: record.item.name,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revoked: record.revoked,
    preset: record.preset,
    subtitleStreamIndex: record.subtitleStreamIndex,
  };
}
