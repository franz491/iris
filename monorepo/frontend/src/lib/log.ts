// lib/log.ts — tiny verbosity-gated logger for the frontend.
// Level lives in localStorage ("iris.logLevel"): silent | info | debug.

export type LogLevel = "silent" | "info" | "debug";

const KEY = "iris.logLevel";
const ORDER: Record<LogLevel, number> = { silent: 0, info: 1, debug: 2 };

export function getLogLevel(): LogLevel {
  const v = localStorage.getItem(KEY);
  return v === "silent" || v === "debug" || v === "info" ? v : "info";
}

export function setLogLevel(level: LogLevel): void {
  localStorage.setItem(KEY, level);
}

/** Log only when the current level includes it (debug implies info). */
export function log(level: Exclude<LogLevel, "silent">, ...args: unknown[]): void {
  if (ORDER[getLogLevel()] < ORDER[level]) return;
  if (level === "debug") console.debug("[iris]", ...args);
  else console.info("[iris]", ...args);
}
