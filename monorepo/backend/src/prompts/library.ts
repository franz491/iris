// prompts/library.ts — named system/usage prompts with layered resolution.
//
// Resolution order (first hit wins):
//   1. DB value        (prompt_prefs via CLI `prompt set <key>`, per-user or global)
//   2. data-dir file   (data/prompts/<key>.md — admin-edited on the machine)
//   3. built-in default (src/prompts/defaults/<key>.md, shipped with the app)
//
// Keys include "importantInfo" (final architecture guidance), "groupChat"
// (conditional routing), "noReply" (optional silence), and "tool:<registryName>".
// Files on disk sanitize ":" to "." (e.g. tool:read_file -> tool.read_file.md).
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "../db/sqlite.js";
import { getPrompt } from "./prompts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = join(HERE, "defaults");
const TOOLS_DIR = join(HERE, "tools");
const PROMPTS_DATA_DIR = path.join(DATA_DIR, "prompts");

/** Built-in prompt files are immutable, but keys can be supplied by plugins or
 * local configuration. Keep the process cache bounded and explicitly owned. */
export const BUILTIN_PROMPT_CACHE_MAX_ENTRIES = 256;
const cache = new Map<string, string>();

function fileFor(key: string): string {
  return `${key.replace(/:/g, ".")}.md`;
}

/** Built-in default bundled with the source tree. */
function builtinDefault(key: string): string | null {
  if (cache.has(key)) return cache.get(key)!;
  const parts = key.split(":");
  const p =
    parts[0] === "tool" && parts[1]
      ? join(TOOLS_DIR, parts[1], parts.length === 2 ? "tool.md" : `${parts.slice(2).join("_")}.md`)
      : join(DEFAULTS_DIR, fileFor(key));
  if (!existsSync(p)) return null;
  const v = readFileSync(p, "utf8").trim();
  cache.set(key, v);
  while (cache.size > BUILTIN_PROMPT_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== "string") break;
    cache.delete(oldest);
  }
  return v;
}

/** Clear owned built-in prompt contents during shutdown or test isolation. */
export function clearBuiltinPromptCache(): void {
  cache.clear();
}

/** Deterministic cache-size probe for lifecycle/performance tests. */
export function builtinPromptCacheSize(): number {
  return cache.size;
}

/** Machine-local override file under the data directory. */
function dataFileOverride(key: string): string | null {
  const p = join(PROMPTS_DATA_DIR, fileFor(key));
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return null;
  }
}

/**
 * Resolve a prompt by key. userId optionally selects a user-specific DB
 * override. Returns null when nothing exists anywhere.
 */
export async function resolvePrompt(key: string, userId?: string): Promise<string | null> {
  let db: string | null = null;
  try {
    db = await getPrompt(key, userId);
  } catch {
    // prompts table missing (e.g. tests that never migrated it) -> use files
  }
  if (db) return db;
  return dataFileOverride(key) ?? builtinDefault(key);
}

/** Where an admin should put a machine-local override for this key. */
export function dataFilePath(key: string): string {
  return join(PROMPTS_DATA_DIR, fileFor(key));
}

/** Ensure the data/prompts directory exists (for `prompt set --file` flows). */
export function ensureDataDir(): void {
  mkdirSync(PROMPTS_DATA_DIR, { recursive: true });
}

/** Every editable prompt key: built-in defaults plus tool generic/function
 *  prompts, merged with any machine-local override files. */
export function listPromptKeys(): Array<{ key: string; group: "core" | "tool" }> {
  const keys = new Map<string, "core" | "tool">();
  const add = (file: string) => {
    if (!file.endsWith(".md")) return;
    const base = file.slice(0, -3);
    if (base.includes(".")) {
      const [group_, ...rest] = base.split(".");
      if (group_ !== "tool" || rest.length === 0) return;
      keys.set(`tool:${rest.join(":")}`, "tool");
    } else {
      keys.set(base, "core");
    }
  };
  try {
    for (const f of readdirSync(DEFAULTS_DIR)) add(f);
  } catch {}
  try {
    for (const dir of readdirSync(TOOLS_DIR)) {
      try {
        for (const f of readdirSync(join(TOOLS_DIR, dir)))
          if (f.endsWith(".md")) {
            const name = f.slice(0, -3);
            keys.set(name === "tool" ? `tool:${dir}` : `tool:${dir}:${name}`, "tool");
          }
      } catch {}
    }
  } catch {}
  try {
    for (const f of readdirSync(PROMPTS_DATA_DIR)) add(f);
  } catch {}
  return [...keys.entries()].map(([key, group]) => ({ key, group })).sort((a, b) => a.key.localeCompare(b.key));
}
