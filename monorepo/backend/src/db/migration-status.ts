import Database from "better-sqlite3";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
export type MigrationStatus = "missing" | "current" | "old" | "newer" | "corrupt";
export const MIGRATION_REGISTRY = [
  { database: "chat.db", ledger: "chat_schema_migrations", supportedVersion: 1 },
  { database: "prompts.db", ledger: "prompts_schema_migrations", supportedVersion: 1 },
  { database: "memory.db", ledger: "memory_schema_migrations", supportedVersion: 1 },
  { database: "config.db", ledger: "config_schema_migrations", supportedVersion: 1 },
  { database: "admin.db", ledger: "admin_schema_migrations", supportedVersion: 1 },
  { database: "admin.db", family: "bootstrap", ledger: "admin_bootstrap_schema_migrations", supportedVersion: 1 },
  { database: "admin.db", family: "models", ledger: "admin_models_schema_migrations", supportedVersion: 1 },
  { database: "admin.db", family: "workflows", ledger: "admin_comfy_workflows_schema_migrations", supportedVersion: 1 },
  { database: "admin.db", family: "tts", ledger: "admin_tts_playback_schema_migrations", supportedVersion: 1 },
] as const;
export function inspectOwnedMigrations(root: string) {
  return MIGRATION_REGISTRY.map((entry) => ({
    ...entry,
    result: inspectMigrationLedger(path.join(root, entry.database), entry.ledger, entry.supportedVersion, root),
  }));
}
export function migrationStatusJson(root: string): string {
  const report = inspectOwnedMigrations(root);
  if (report.some((x) => x.result.status === "newer" || x.result.status === "corrupt"))
    throw new Error("unsafe migration status");
  return JSON.stringify(report);
}
export function inspectMigrationLedger(
  file: string,
  ledger: string,
  supported: number,
  root: string,
): { status: MigrationStatus; version?: number } {
  const absolute = path.resolve(file),
    base = path.resolve(root),
    rel = path.relative(base, absolute);
  if (!Number.isSafeInteger(supported) || supported < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ledger))
    throw new Error("invalid migration inspection arguments");
  if (lstatSync(base).isSymbolicLink()) throw new Error("root must not be a symlink");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("database path outside root or symlink");
  let current = base;
  for (const component of rel.split(path.sep)) {
    current = path.join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("database path outside root or symlink");
  }
  if (!existsSync(absolute)) return { status: "missing" };
  const db = new Database(absolute, { readonly: true });
  try {
    const row = db.prepare(`SELECT version FROM ${ledger} ORDER BY version DESC LIMIT 1`).get() as
      { version?: unknown } | undefined;
    if (!row || typeof row.version !== "number") return { status: "missing" };
    const version = row.version;
    return { version, status: version === supported ? "current" : version < supported ? "old" : "newer" };
  } catch (error) {
    if (error instanceof Error && /no such table/i.test(error.message)) return { status: "missing" };
    return { status: "corrupt" };
  } finally {
    db.close();
  }
}
