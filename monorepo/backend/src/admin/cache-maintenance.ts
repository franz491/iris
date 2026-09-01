/** Offline cache maintenance. Intentionally does not import admin/audio-cache or its singleton. */
import Database from "better-sqlite3";
import { existsSync, lstatSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db/sqlite.js";

export interface CacheMaintenanceOptions {
  apply?: boolean;
  confirmation?: string;
  dataRoot?: string;
  beforeMutation?: () => void;
}
export interface CacheMaintenanceResult {
  dryRun: boolean;
  rows: number;
  artifacts: string[];
}

export function maintainOfflineCache(options: CacheMaintenanceOptions = {}): CacheMaintenanceResult {
  const root = path.resolve(options.dataRoot ?? DATA_DIR);
  if (root !== DATA_DIR && options.dataRoot === undefined) throw new Error("canonical data root required");
  if (existsSync(root) && lstatSync(root).isSymbolicLink())
    throw new Error("canonical data root must not be a symlink");
  const dbPath = path.join(root, "admin.db"),
    cacheDir = path.join(root, "tts-cache");
  if (!existsSync(dbPath) || lstatSync(dbPath).isSymbolicLink())
    throw new Error("canonical admin database missing or symlink");
  const db = new Database(dbPath, { readonly: !options.apply });
  try {
    db.pragma("busy_timeout = 100");
    const configRow = db.prepare("SELECT config FROM admin_state WHERE id=1").get() as { config?: string } | undefined;
    if (!configRow?.config) throw new Error("canonical admin configuration missing");
    const config = JSON.parse(configRow.config) as { cache?: { enabled?: boolean } };
    if (config.cache?.enabled) throw new Error("cache must be disabled in canonical configuration");
    const rows = Number((db.prepare("SELECT COUNT(*) AS n FROM admin_tts_playback").get() as { n: number }).n);
    if (existsSync(cacheDir) && lstatSync(cacheDir).isSymbolicLink()) throw new Error("cache directory symlink");
    const artifacts = existsSync(cacheDir) ? readdirSync(cacheDir).map((n) => path.join(cacheDir, n)) : [];
    if (artifacts.some((p) => lstatSync(p).isSymbolicLink() || path.dirname(p) !== cacheDir))
      throw new Error("cache artifact symlink or confinement failure");
    if (!options.apply) return { dryRun: true, rows, artifacts };
    if (options.confirmation !== "CACHE_PURGE") throw new Error("apply requires confirmation CACHE_PURGE");
    options.beforeMutation?.();
    // Revalidate immediately before mutation; no recursive or glob deletion.
    if (
      JSON.parse((db.prepare("SELECT config FROM admin_state WHERE id=1").get() as { config: string }).config).cache
        ?.enabled
    )
      throw new Error("cache enabled during revalidation");
    db.prepare("DELETE FROM admin_tts_playback").run();
    for (const artifact of artifacts) {
      if (lstatSync(artifact).isSymbolicLink()) throw new Error("cache artifact changed");
      unlinkSync(artifact);
    }
    return { dryRun: false, rows, artifacts };
  } finally {
    db.close();
  }
}
