import { createHash, randomBytes } from "node:crypto";
import { openDb, dataFile } from "../db/sqlite.js";
export const db = openDb(dataFile("admin.db")).sqlite;
export function migrateBootstrapDb(injectFailure = false, connection = db): void {
  connection.transaction(() => {
    connection.exec(
      "CREATE TABLE IF NOT EXISTS admin_bootstrap (id INTEGER PRIMARY KEY CHECK(id=1), token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS admin_bootstrap_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    if (injectFailure) throw new Error("injected bootstrap migration failure");
    connection.prepare("INSERT OR IGNORE INTO admin_bootstrap_schema_migrations VALUES (1, ?)").run(Date.now());
  })();
}
migrateBootstrapDb();
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
let issued: string | null = null;
export function bootstrapAvailable(): boolean {
  const row = db.prepare("SELECT used,expires_at FROM admin_bootstrap WHERE id=1").get() as
    { used: number; expires_at: number } | undefined;
  return Boolean(row && !row.used && row.expires_at > Date.now());
}
export function issueBootstrapToken(ttlSeconds = 600): string {
  const token = process.env.IRIS_BOOTSTRAP_TOKEN ?? randomBytes(24).toString("base64url");
  db.prepare(
    "INSERT INTO admin_bootstrap(id,token_hash,expires_at,used) VALUES(1,?,?,0) ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,used=0",
  ).run(hash(token), Date.now() + ttlSeconds * 1000);
  issued = token;
  return token;
}
export function consumeBootstrapToken(token: string): boolean {
  const result = db
    .prepare("UPDATE admin_bootstrap SET used=1 WHERE id=1 AND used=0 AND expires_at>? AND token_hash=?")
    .run(Date.now(), hash(token));
  if (result.changes !== 1) return false;
  issued = null;
  return true;
}
/** Atomically reserve a token while account creation is in progress. */
export function claimBootstrapToken(token: string): boolean {
  return (
    db
      .prepare("UPDATE admin_bootstrap SET used=2 WHERE id=1 AND used=0 AND expires_at>? AND token_hash=?")
      .run(Date.now(), hash(token)).changes === 1
  );
}

/** Mark a successfully consumed reservation as permanently used. */
export function completeBootstrapToken(token: string): void {
  db.prepare("UPDATE admin_bootstrap SET used=1 WHERE id=1 AND used=2 AND token_hash=?").run(hash(token));
  issued = null;
}

/** Return a failed account-creation reservation to the available state. */
export function releaseBootstrapToken(token: string): void {
  db.prepare("UPDATE admin_bootstrap SET used=0 WHERE id=1 AND used=2 AND token_hash=?").run(hash(token));
}
export function currentBootstrapTokenForTerminal(): string | null {
  return issued;
}
