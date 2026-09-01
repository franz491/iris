// misc/regex-worker.ts — run arbitrary user-supplied regexes in a worker
// thread with a timeout, so catastrophic-backtracking patterns (ReDoS) can
// only burn the worker, not the event loop.
import { Worker } from "node:worker_threads";
import { AppError } from "./error.js";

const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const { op, pattern, flags, text, substitution } = workerData;
try {
  const re = new RegExp(pattern, flags);
  if (op === "replace") {
    parentPort.postMessage({ ok: true, result: text.replace(re, substitution) });
  } else {
    // match: return [lineNumber, line] pairs (1-indexed lines)
    const lines = text.split("\\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) out.push([i + 1, lines[i]]);
    }
    parentPort.postMessage({ ok: true, result: out });
  }
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e) });
}
`;

function run<T>(
  op: "replace" | "match",
  pattern: string,
  flags: string,
  text: string,
  substitution: string,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { op, pattern, flags, text, substitution },
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new AppError(`regex timed out after ${timeoutMs}ms`, "regex_timeout"));
    }, timeoutMs);
    worker.once("message", (msg: { ok: boolean; result?: T; error?: string }) => {
      clearTimeout(timer);
      if (msg.ok) resolve(msg.result as T);
      else reject(new AppError(`invalid regex: ${msg.error}`, "invalid_regex"));
    });
    worker.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Replace with timeout; throws regex_timeout on runaway patterns. */
export function replaceWithTimeout(
  pattern: string,
  flags: string,
  text: string,
  substitution: string,
  timeoutMs: number,
): Promise<string> {
  return run<string>("replace", pattern, flags, text, substitution, timeoutMs);
}

/** Match all lines; returns [lineNumber, line] pairs. */
export function matchLinesWithTimeout(
  pattern: string,
  flags: string,
  text: string,
  timeoutMs: number,
): Promise<[number, string][]> {
  return run<[number, string][]>("match", pattern, flags, text, "", timeoutMs);
}
