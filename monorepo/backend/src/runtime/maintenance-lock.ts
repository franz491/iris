/** Data-root ownership lock shared by the live backend and offline maintenance. */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../db/sqlite.js";

export interface MaintenanceLock {
  path: string;
  release(): void;
}
export interface MaintenanceLockOptions {
  processAlive?: (pid: number) => boolean;
  processIdentity?: (pid: number) => string | undefined;
  now?: () => number;
}

const MALFORMED_LOCK_GRACE_MS = 30_000;

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function processIdentity(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return close < 0
      ? undefined
      : stat
          .slice(close + 2)
          .trim()
          .split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockIsStale(lockPath: string, options: MaintenanceLockOptions): boolean {
  try {
    if (lstatSync(lockPath).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return false;
  }
  try {
    const record = JSON.parse(raw) as { pid?: unknown; processStartIdentity?: unknown };
    if (!validPid(record.pid))
      return (options.now?.() ?? Date.now()) - statSync(lockPath).mtimeMs > MALFORMED_LOCK_GRACE_MS;
    if (!(options.processAlive ?? processAlive)(record.pid)) return true;
    const current = (options.processIdentity ?? processIdentity)(record.pid);
    return (
      current !== undefined &&
      typeof record.processStartIdentity === "string" &&
      current !== record.processStartIdentity
    );
  } catch {
    try {
      return (options.now?.() ?? Date.now()) - statSync(lockPath).mtimeMs > MALFORMED_LOCK_GRACE_MS;
    } catch {
      return false;
    }
  }
}

/** Acquire the exclusive data-root runtime/maintenance lock. Dead owners are
 * reclaimed with an atomic rename, so concurrent starters can never both win. */
export function acquireMaintenanceLock(
  root = DATA_DIR,
  operation = "maintenance",
  options: MaintenanceLockOptions = {},
): MaintenanceLock {
  const lockPath = path.join(path.resolve(root), "locks", "iris-maintenance.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      const token = randomUUID();
      writeFileSync(
        fd,
        JSON.stringify({
          operation,
          pid: process.pid,
          processStartIdentity: processIdentity(process.pid),
          token,
          createdAt: Date.now(),
        }),
        { encoding: "utf8" },
      );
      let released = false;
      return {
        path: lockPath,
        release() {
          if (released) return;
          released = true;
          try {
            closeSync(fd);
          } finally {
            try {
              const current = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
              if (current.token === token) unlinkSync(lockPath);
            } catch {
              /* already reclaimed or removed */
            }
          }
        },
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        !existsSync(lockPath) ||
        !lockIsStale(lockPath, options)
      ) {
        throw new Error("Iris data root is already owned by a running or uncleanly stopped process", { cause: error });
      }
      const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
      try {
        renameSync(lockPath, quarantine);
        unlinkSync(quarantine);
      } catch {
        /* another contender won */
      }
    }
  }
}
