// db/sqlite.ts
// Shared SQLite bootstrap. All databases live under IRIS_DATA_DIR. Production
// defaults use the platform's application-data location, never the source tree.
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

const configuredDataDir = process.env.IRIS_DATA_DIR;

export function defaultDataDirectory(
  operatingSystem: NodeJS.Platform,
  homeDirectory: string,
  xdgDataHome: string | undefined,
  appDataDirectory: string | undefined,
): string {
  if (operatingSystem === "win32") {
    return path.join(appDataDirectory || path.join(homeDirectory, "AppData", "Roaming"), "Iris");
  }
  if (operatingSystem === "darwin") return path.join(homeDirectory, "Library", "Application Support", "Iris");
  return path.join(xdgDataHome || path.join(homeDirectory, ".local", "share"), "iris");
}

if (process.env.VITEST && !configuredDataDir) {
  throw new Error("IRIS_DATA_DIR must be set to a temporary directory before importing database modules in tests");
}

export const DATA_DIR = configuredDataDir
  ? path.resolve(configuredDataDir)
  : defaultDataDirectory(platform(), homedir(), process.env.XDG_DATA_HOME, process.env.APPDATA);

function ensureDataDirectory(): void {
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const root = lstatSync(DATA_DIR);
  if (root.isSymbolicLink()) {
    throw new Error("IRIS_DATA_DIR must not be a symbolic link");
  }
  if (!root.isDirectory()) throw new Error("IRIS_DATA_DIR must be a directory");
  chmodSync(DATA_DIR, 0o700);
}

export function dataFile(name: string): string {
  ensureDataDirectory();
  const file = path.resolve(DATA_DIR, name);
  const relative = path.relative(DATA_DIR, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("data file must stay within IRIS_DATA_DIR");
  }
  // Do not allow an existing nested component to redirect access outside the
  // configured root. This also catches a symlinked database file before the
  // SQLite driver follows it.
  let current = DATA_DIR;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("data files must not use symbolic links");
    }
  }
  return file;
}

export type Db = BetterSQLite3Database<Record<string, never>> & { $client: Database.Database };
const openDatabases = new Set<Database.Database>();

/** Checkpoint WAL and close every database exactly once during shutdown. */
export function closeAllDatabases(): void {
  for (const sqlite of [...openDatabases]) {
    try {
      sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* best effort */
    }
    try {
      sqlite.close();
    } catch {
      /* already closed */
    }
    openDatabases.delete(sqlite);
  }
}

export function openDb(file: string): { sqlite: Database.Database; db: Db } {
  const relative = path.relative(DATA_DIR, path.resolve(file));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("database file must stay within IRIS_DATA_DIR");
  }
  ensureDataDirectory();
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new Error("database files must not be symbolic links");
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  const sqlite = new Database(file);
  openDatabases.add(sqlite);
  chmodSync(file, 0o600);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite) as Db;
  return { sqlite, db };
}
