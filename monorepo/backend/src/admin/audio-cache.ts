import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataFile, openDb } from "../db/sqlite.js";
import { recordDbOperation, setGauge } from "../misc/metrics.js";
import { readRuntimeLimits } from "../config/runtime-limits.js";

export interface PlaybackMetadata {
  text: string;
  language?: string;
  voice?: string;
  style?: string;
  service?: string;
  profile?: string;
  model?: string;
  chatId?: string;
}
export interface CacheLimits {
  maxAgeSeconds: number;
  maxBytes: number;
}
interface Entry extends PlaybackMetadata {
  id: string;
  file: string | null;
  mimeType: string;
  createdAt: number;
  lastAccess: number;
  bytes: number;
}
const metadataKeys = new Set(["text", "language", "voice", "style", "service", "profile", "model", "chatId"]);

function normalizeMime(mimeType: string): string {
  const value = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (!value || !/^audio\/[a-z0-9][a-z0-9.+-]{0,126}$/.test(value)) throw new Error("invalid audio MIME type");
  return value;
}

const dir = dataFile("tts-cache");
mkdirSync(dir, { recursive: true });
export const db = openDb(dataFile("admin.db")).sqlite;
export function migrateTtsPlaybackDb(injectFailure = false, connection = db): void {
  connection.transaction(() => {
    connection.exec(`CREATE TABLE IF NOT EXISTS admin_tts_playback (
  id TEXT PRIMARY KEY, metadata TEXT NOT NULL, file TEXT, mime_type TEXT NOT NULL,
  created_at INTEGER NOT NULL, last_access INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0
) ; CREATE TABLE IF NOT EXISTS admin_tts_playback_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    if (injectFailure) throw new Error("injected tts migration failure");
    connection.prepare("INSERT OR IGNORE INTO admin_tts_playback_schema_migrations VALUES(1, ?)").run(Date.now());
  })();
}
migrateTtsPlaybackDb();

function metadataOf(e: Entry): PlaybackMetadata {
  const { id: _, file: __, mimeType: ___, createdAt: ____, lastAccess: _____, bytes: ______, ...metadata } = e;
  return metadata;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
function parseMetadata(value: unknown): PlaybackMetadata | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || typeof parsed.text !== "string") return null;
    for (const key of Object.keys(parsed))
      if (!metadataKeys.has(key) || (key !== "text" && typeof parsed[key] !== "string")) return null;
    return parsed as unknown as PlaybackMetadata;
  } catch {
    return null;
  }
}
function rowToEntry(value: unknown): Entry | null {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return null;
  const metadata = parseMetadata(value.metadata);
  let mimeType: string;
  if (typeof value.mime_type !== "string") return null;
  try {
    // Treat persisted rows as untrusted at the replay boundary.  Besides
    // rejecting malformed values, normalization prevents a tampered MIME
    // value from becoming an arbitrary response header/content type.
    mimeType = normalizeMime(value.mime_type);
  } catch {
    return null;
  }
  if (
    !metadata ||
    !(value.file === null || typeof value.file === "string") ||
    typeof value.mime_type !== "string" ||
    !isInteger(value.created_at) ||
    !isInteger(value.last_access) ||
    !isInteger(value.bytes) ||
    value.bytes < 0
  )
    return null;
  const expectedFile = join(dir, `${value.id}.wav`);
  if (value.file !== null && value.file !== expectedFile) return null;
  return {
    ...metadata,
    id: value.id,
    file: value.file,
    mimeType,
    createdAt: value.created_at,
    lastAccess: value.last_access,
    bytes: value.bytes,
  };
}
function rowsToEntries(rows: unknown[]): Entry[] {
  return rows.flatMap((row) => {
    const entry = rowToEntry(row);
    return entry ? [entry] : [];
  });
}
function getEntry(id: string): Entry | null {
  const row = db.prepare("SELECT * FROM admin_tts_playback WHERE id=?").get(id) as unknown;
  return rowToEntry(row);
}
function writeEntry(entry: Entry): void {
  db.prepare("INSERT OR REPLACE INTO admin_tts_playback VALUES (?,?,?,?,?,?,?)").run(
    entry.id,
    JSON.stringify(metadataOf(entry)),
    entry.file,
    entry.mimeType,
    entry.createdAt,
    entry.lastAccess,
    entry.bytes,
  );
}

export function cacheAudio(
  bytes: Uint8Array,
  metadata: PlaybackMetadata,
  limits: CacheLimits,
  mimeType = "audio/wav",
): string {
  const id = randomUUID();
  storeAudio(id, bytes, metadata, limits, mimeType, Date.now());
  return id;
}
function storeAudio(
  id: string,
  bytes: Uint8Array,
  metadata: PlaybackMetadata,
  limits: CacheLimits,
  mimeType: string,
  createdAt: number,
): void {
  const runtimeLimit = readRuntimeLimits().ttsAudioBytes;
  if (bytes.byteLength > runtimeLimit || (limits.maxBytes > 0 && bytes.byteLength > limits.maxBytes))
    throw new Error("audio exceeds configured cache limit");
  const normalizedMime = normalizeMime(mimeType);
  const file = join(dir, `${id}.wav`);
  const temporary = join(dir, `.${id}.tmp`);
  try {
    writeFileSync(temporary, bytes, { mode: 0o600 });
    renameSync(temporary, file);
    writeEntry({
      ...metadata,
      id,
      file,
      mimeType: normalizedMime,
      createdAt,
      lastAccess: Date.now(),
      bytes: bytes.byteLength,
    });
    evict(limits);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    try {
      unlinkSync(file);
    } catch {}
    try {
      db.prepare("DELETE FROM admin_tts_playback WHERE id=?").run(id);
    } catch {}
    throw error;
  }
}
export function restoreCachedAudio(
  id: string,
  bytes: Uint8Array,
  limits: CacheLimits,
  mimeType = "audio/wav",
): boolean {
  const entry = getEntry(id);
  if (!entry) return false;
  storeAudio(id, bytes, metadataOf(entry), limits, mimeType, entry.createdAt);
  return true;
}
export function getPlaybackMetadata(id: string, chatId?: string): PlaybackMetadata | null {
  const entry = getEntry(id);
  if (!entry || (chatId && entry.chatId !== chatId)) return null;
  return metadataOf(entry);
}
export function readCachedAudio(
  id: string,
  limits: CacheLimits,
  chatId?: string,
): { bytes: Buffer; metadata: PlaybackMetadata; mimeType: string } | null {
  evict(limits);
  const entry = getEntry(id);
  if (!entry || (chatId && entry.chatId !== chatId) || !entry.file) return null;
  try {
    const stat = statSync(entry.file);
    const runtimeLimit = readRuntimeLimits().ttsAudioBytes;
    if (!stat.isFile() || stat.size !== entry.bytes || stat.size > runtimeLimit)
      throw new Error("invalid cached audio size");
    const bytes = readFileSync(entry.file);
    db.prepare("UPDATE admin_tts_playback SET last_access=? WHERE id=?").run(Date.now(), id);
    return { bytes, metadata: metadataOf(entry), mimeType: entry.mimeType };
  } catch {
    db.prepare("UPDATE admin_tts_playback SET file=NULL,bytes=0 WHERE id=?").run(id);
    return null;
  }
}
function removeAudio(entry: Entry): void {
  if (entry.file)
    try {
      unlinkSync(entry.file);
    } catch {}
  db.prepare("UPDATE admin_tts_playback SET file=NULL,bytes=0 WHERE id=?").run(entry.id);
}
export function evict(limits: CacheLimits): void {
  const entries = rowsToEntries(
    db.prepare("SELECT * FROM admin_tts_playback WHERE file IS NOT NULL ORDER BY last_access ASC").all() as unknown[],
  );
  const now = Date.now();
  for (const entry of entries) {
    if (limits.maxAgeSeconds > 0 && now - entry.createdAt > limits.maxAgeSeconds * 1000) removeAudio(entry);
  }
  if (limits.maxBytes > 0) {
    const remaining = rowsToEntries(
      db.prepare("SELECT * FROM admin_tts_playback WHERE file IS NOT NULL ORDER BY last_access ASC").all() as unknown[],
    );
    let total = remaining.reduce((sum, e) => sum + e.bytes, 0);
    for (const entry of remaining) {
      if (total <= limits.maxBytes) break;
      removeAudio(entry);
      total -= entry.bytes;
    }
  }
  const known = new Set(
    rowsToEntries(db.prepare("SELECT * FROM admin_tts_playback WHERE file IS NOT NULL").all() as unknown[]).flatMap(
      (entry) => (entry.file ? [entry.file] : []),
    ),
  );
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (!known.has(file))
      try {
        if (statSync(file).isFile()) unlinkSync(file);
      } catch {}
  }
}
export function cacheStats(): { entries: number; cachedFiles: number; bytes: number } {
  const started = Date.now();
  let failed = false;
  let value: unknown;
  try {
    value = db
      .prepare("SELECT COUNT(*) entries,COUNT(file) cached_files,COALESCE(SUM(bytes),0) bytes FROM admin_tts_playback")
      .get() as unknown;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    recordDbOperation(Date.now() - started, failed);
  }
  if (
    !isRecord(value) ||
    !isInteger(value.entries) ||
    !isInteger(value.cached_files) ||
    !isInteger(value.bytes) ||
    value.entries < 0 ||
    value.cached_files < 0 ||
    value.bytes < 0
  )
    return { entries: 0, cachedFiles: 0, bytes: 0 };
  const result = { entries: value.entries, cachedFiles: value.cached_files, bytes: value.bytes };
  setGauge("cache.entries", result.entries);
  setGauge("cache.bytes", result.bytes);
  return result;
}
