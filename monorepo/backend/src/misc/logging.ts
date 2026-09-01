// misc/logging.ts
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import crypto from "node:crypto";
import { readRuntimeLimits } from "../config/runtime-limits.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<Exclude<LogLevel, "silent">, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let minLevel: Exclude<LogLevel, "silent"> =
  (process.env.IRIS_LOG_LEVEL as LogLevel) in LEVEL_ORDER
    ? (process.env.IRIS_LOG_LEVEL as Exclude<LogLevel, "silent">)
    : "info";
let file: string | null = process.env.IRIS_LOG_FILE ?? null;

const REDACTED = "[REDACTED]";
const pseudonymKey = crypto.randomBytes(32);
export function pseudonym(value: string): string {
  return `p_${crypto.createHmac("sha256", pseudonymKey).update(value).digest("hex").slice(0, 16)}`;
}
export function eventRecord(
  component: string,
  event: string,
  fields: Record<string, unknown> = {},
  level: Exclude<LogLevel, "silent"> = "info",
) {
  const safe = Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        /^(correlationId|actor_ref|chat_ref|status|durationMs|outcome|code|count)$/.test(key) &&
        (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
    ),
  );
  return { timestamp: new Date().toISOString(), level, component, event, ...safe };
}
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Remove credentials from text before it reaches console or file logs. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/(\bauthorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;"']+/gi, `$1${REDACTED}`)
    .replace(/(\b(?:cookie|set-cookie)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:sk|pk|rk|sess|tok|key)-[A-Za-z0-9][A-Za-z0-9._-]*/g, REDACTED)
    .replace(
      /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      `$1${REDACTED}`,
    );
}

export function setLogLevel(level: LogLevel): void {
  if (level === "silent") {
    // hack: order above error
    minLevel = "error";
    LEVEL_ORDER.error = 100; // suppress everything
    return;
  }
  if (LEVEL_ORDER.error > 40) LEVEL_ORDER.error = 40;
  minLevel = level;
}

export function setLogFile(path: string | null): void {
  file = path;
}

export function errorEvent(
  component: string,
  event: string,
  code: string,
  correlationId: string | undefined,
  error: unknown,
  fields: Record<string, unknown> = {},
) {
  const detail = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : error;
  let serialized: string;
  try {
    serialized = typeof detail === "string" ? detail : JSON.stringify(detail);
  } catch {
    serialized = "unserializable error";
  }
  return {
    timestamp: new Date().toISOString(),
    level: "error",
    component,
    event,
    code,
    ...(correlationId ? { correlationId } : {}),
    error: redactSensitiveText(serialized).slice(0, 64 * 1024),
    ...Object.fromEntries(
      Object.entries(fields).filter(([key, value]) => /^(actor_ref|chat_ref)$/.test(key) && typeof value === "string"),
    ),
  };
}

async function write(level: Exclude<LogLevel, "silent">, msg: string): Promise<void> {
  if (!file) return;
  try {
    await mkdir(dirname(file), { recursive: true });
    const line = `${JSON.stringify({ t: new Date().toISOString(), level, msg })}\n`;
    try {
      const size = (await stat(file)).size;
      if (size + Buffer.byteLength(line) > readRuntimeLimits().logBytes) {
        const rotated = `${file}.1`;
        await unlink(rotated).catch(() => undefined);
        await rename(file, rotated).catch(() => undefined);
      }
    } catch {
      // The file may not exist yet.
    }
    await appendFile(file, line);
  } catch {
    /* logging must never throw */
  }
}

function log(level: Exclude<LogLevel, "silent">, scope: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const fmt = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };
  const msg = redactSensitiveText(args.map(fmt).join(" "));
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${scope}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  void write(level, line);
}

/** Returns a scoped logger, e.g. const log = logger("kernel"); log.info("hi"); */
export function logger(scope: string) {
  return {
    debug: (...args: unknown[]) => log("debug", scope, args),
    info: (...args: unknown[]) => log("info", scope, args),
    warn: (...args: unknown[]) => log("warn", scope, args),
    error: (...args: unknown[]) => log("error", scope, args),
  };
}
