// Admin-managed named API keys. Values are encrypted at rest with AES-256-GCM.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { openDb, dataFile } from "../db/sqlite.js";

const MAX_KEY_BYTES = 4096;
const MASTER_ENV = "IRIS_API_KEYS_MASTER_KEY";
const MASTER_FILE_ENV = "IRIS_API_KEYS_MASTER_KEY_FILE";
const apiKeys = sqliteTable("api_keys", {
  name: text("name").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  nonce: text("nonce").notNull(),
  tag: text("tag").notNull(),
  createdAt: integer("created_at").notNull(),
});
const nameSchema = z.string().min(1).max(256);
const writeSchema = z.object({
  name: nameSchema,
  key: z
    .string()
    .min(1)
    .max(MAX_KEY_BYTES)
    .refine((value) => Buffer.byteLength(value, "utf8") <= MAX_KEY_BYTES, "key exceeds byte limit"),
});
const { sqlite, db } = openDb(dataFile("keys.db"));

export function isPrivateMasterKeyFile(
  mode: number,
  uid: number | undefined,
  currentUid: number | undefined,
  isRegular: boolean,
): boolean {
  return (
    isRegular &&
    (process.platform === "win32" || ((mode & 0o077) === 0 && (currentUid === undefined || uid === currentUid)))
  );
}
function masterKey(): Buffer {
  let raw = process.env[MASTER_ENV] ?? "";
  if (!raw && process.env[MASTER_FILE_ENV]) {
    return readApiKeyMasterKeyFile(process.env[MASTER_FILE_ENV]);
  }
  if (!raw)
    throw new Error(`API-key encryption key unavailable: set ${MASTER_ENV} (base64, 32 bytes) or ${MASTER_FILE_ENV}`);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0)
    throw new Error("API-key encryption key is invalid; expected canonical base64");
  return validateMasterKey(Buffer.from(raw, "base64"));
}
function validateMasterKey(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw new Error("API-key encryption key is invalid; expected exactly 32 decoded bytes");
  return Buffer.from(key);
}
export function parseApiKeyMasterKey(raw: string): Buffer {
  const value = raw.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error("API-key encryption key is invalid; expected canonical base64");
  return validateMasterKey(Buffer.from(value, "base64"));
}
export function readApiKeyMasterKeyFile(file: string): Buffer {
  if (!file || file.length > 4096) throw new Error("API-key master-key file path is invalid");
  const stat = lstatSync(file);
  if (
    !isPrivateMasterKeyFile(
      stat.mode,
      stat.uid,
      typeof process.getuid === "function" ? process.getuid() : undefined,
      stat.isFile(),
    ) ||
    stat.size > 256
  )
    throw new Error("API-key master-key file must be a private regular file owned by the service account");
  return parseApiKeyMasterKey(readFileSync(file, "utf8"));
}
function seal(value: string, key = masterKey()) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", validateMasterKey(key), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
function open(row: { ciphertext: string; nonce: string; tag: string }, key = masterKey()): string {
  validateMasterKey(key);
  try {
    const decode = (value: string) => {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error("invalid encoding");
      return Buffer.from(value, "base64");
    };
    const nonce = decode(row.nonce);
    const tag = decode(row.tag);
    const ciphertext = decode(row.ciphertext);
    if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_KEY_BYTES)
      throw new Error("invalid ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    const value = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    if (Buffer.byteLength(value) > MAX_KEY_BYTES) throw new Error("oversized");
    return value;
  } catch {
    throw new Error("Unable to decrypt API key; key may be unavailable or incorrect");
  }
}
function migrateSchema(): void {
  const columns = sqlite.prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
  if (!columns.length) {
    sqlite.exec(
      "CREATE TABLE api_keys (name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, nonce TEXT NOT NULL, tag TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    return;
  }
  if (columns.some((c) => c.name === "ciphertext")) {
    const expected = ["name", "ciphertext", "nonce", "tag", "created_at"];
    if (columns.length !== expected.length || columns.some((c, i) => c.name !== expected[i]))
      throw new Error("API-key database schema is invalid");
    return;
  }
  const legacyExpected = ["name", "key", "created_at"];
  if (columns.length !== legacyExpected.length || columns.some((c, i) => c.name !== legacyExpected[i]))
    throw new Error("API-key database schema is invalid");
  sqlite.pragma("secure_delete = ON");
  sqlite.transaction(() => {
    const rows = sqlite.prepare("SELECT name, key, created_at FROM api_keys").all() as Array<{
      name: string;
      key: string;
      created_at: number;
    }>;
    for (const row of rows) {
      writeSchema.parse({ name: row.name, key: row.key });
      if (!Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new Error("API-key legacy row is invalid");
    }
    const encrypted = rows.map((r) => ({ ...seal(r.key), name: r.name, created_at: r.created_at }));
    sqlite.exec(
      "ALTER TABLE api_keys RENAME TO api_keys_legacy; CREATE TABLE api_keys (name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL, nonce TEXT NOT NULL, tag TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    const insert = sqlite.prepare("INSERT INTO api_keys (name,ciphertext,nonce,tag,created_at) VALUES (?,?,?,?,?)");
    for (const r of encrypted) insert.run(r.name, r.ciphertext, r.nonce, r.tag, r.created_at);
    sqlite.exec("DROP TABLE api_keys_legacy");
  })();
  sqlite.pragma("wal_checkpoint(TRUNCATE)");
  sqlite.exec("VACUUM");
}
migrateSchema();
export function setApiKey(name: string, key: string): void {
  writeSchema.parse({ name, key });
  const value = seal(key);
  db.insert(apiKeys)
    .values({ name, ...value, createdAt: Date.now() })
    .onConflictDoUpdate({ target: apiKeys.name, set: { ...value, createdAt: Date.now() } })
    .run();
}
/** Re-encrypt every stored key without changing the process master-key configuration. */
export function rotateApiKeys(currentKey: Buffer, newKey: Buffer): void {
  validateMasterKey(currentKey);
  validateMasterKey(newKey);
  const rows = sqlite
    .prepare("SELECT name,ciphertext,nonce,tag,created_at FROM api_keys ORDER BY name")
    .all() as Array<{ name: string; ciphertext: string; nonce: string; tag: string; created_at: number }>;
  // Authenticate and validate the complete database before opening a write transaction.
  const plaintext = rows.map((row) => ({ ...row, value: open(row, currentKey) }));
  const rewritten = plaintext.map((row) => ({
    ...seal(row.value, newKey),
    name: row.name,
    created_at: row.created_at,
  }));
  sqlite.transaction(() => {
    const update = sqlite.prepare("UPDATE api_keys SET ciphertext=?,nonce=?,tag=? WHERE name=?");
    for (const row of rewritten) update.run(row.ciphertext, row.nonce, row.tag, row.name);
    const verify = sqlite.prepare("SELECT ciphertext,nonce,tag FROM api_keys WHERE name=?");
    for (const row of plaintext) {
      const stored = verify.get(row.name) as { ciphertext: string; nonce: string; tag: string } | undefined;
      if (!stored || open(stored, newKey) !== row.value) throw new Error("API-key rotation verification failed");
    }
  })();
}
export function deleteApiKey(name: string): boolean {
  return db.delete(apiKeys).where(eq(apiKeys.name, name)).run().changes > 0;
}
export function getApiKey(name: string): string | null {
  const row = sqlite.prepare("SELECT ciphertext,nonce,tag FROM api_keys WHERE name = ?").get(name) as
    { ciphertext: string; nonce: string; tag: string } | undefined;
  return row ? open(row) : null;
}
export function listApiKeyNames(): string[] {
  return (sqlite.prepare("SELECT name FROM api_keys ORDER BY name").all() as Array<{ name: string }>).flatMap((r) =>
    nameSchema.safeParse(r.name).success ? [r.name] : [],
  );
}
