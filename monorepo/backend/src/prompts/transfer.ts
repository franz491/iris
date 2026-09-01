// prompts/transfer.ts — export/import DB prompt overrides as a portable JSON
// file, for reuse across machines. Only DB overrides are exported (built-in
// defaults ship with the app; data-dir md files are machine-local by nature).
import { openDb, dataFile } from "../db/sqlite.js";

const { db } = openDb(dataFile("prompts.db"));
import { promptPrefs } from "./schema.js";
import { setPrompt } from "./prompts.js";
import { isNull } from "drizzle-orm";
import { readRuntimeLimits } from "../config/runtime-limits.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export interface PromptExport {
  kind: "iris.prompts";
  version: 1;
  exportedAt: string;
  /** global overrides only (user-specific ones are machine/account local) */
  prompts: Record<string, string>;
}

export async function exportPrompts(): Promise<PromptExport> {
  const rows = await db.select().from(promptPrefs).where(isNull(promptPrefs.userId));
  const prompts: Record<string, string> = {};
  for (const r of rows) if (r.value.trim()) prompts[r.key] = r.value;
  return { kind: "iris.prompts", version: 1, exportedAt: new Date().toISOString(), prompts };
}

export async function importPrompts(json: string | Buffer): Promise<number> {
  const raw = String(json);
  const limits = readRuntimeLimits();
  if (Buffer.byteLength(raw, "utf8") > limits.promptImportBytes) {
    throw new Error(`prompt import exceeds ${limits.promptImportBytes} byte limit`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("invalid JSON");
  }

  if (
    !isRecord(parsed) ||
    parsed.kind !== "iris.prompts" ||
    parsed.version !== 1 ||
    typeof parsed.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(parsed.exportedAt)) ||
    !isRecord(parsed.prompts)
  ) {
    throw new Error('not an iris.prompts export (expected kind "iris.prompts", version 1)');
  }

  const promptEntries = Object.entries(parsed.prompts);
  if (promptEntries.length > limits.promptCount) {
    throw new Error(`prompt import contains more than ${limits.promptCount} prompts`);
  }

  const entries: Array<[string, string]> = [];
  let promptBytes = 0;
  for (const [key, value] of promptEntries) {
    const keyBytes = Buffer.byteLength(key, "utf8");
    if (!key.trim() || keyBytes > limits.promptKeyBytes || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new Error("prompt import contains an invalid prompt key");
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`prompt import contains an invalid value for ${key}`);
    }
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (valueBytes > limits.promptValueBytes) {
      throw new Error(`prompt import value for ${key} exceeds ${limits.promptValueBytes} byte limit`);
    }
    promptBytes += keyBytes + valueBytes;
    if (promptBytes > limits.promptImportBytes) {
      throw new Error(`prompt import prompt data exceeds ${limits.promptImportBytes} byte limit`);
    }
    entries.push([key, value]);
  }

  let n = 0;
  for (const [key, value] of entries) {
    await setPrompt(key, value);
    n += 1;
  }
  return n;
}
