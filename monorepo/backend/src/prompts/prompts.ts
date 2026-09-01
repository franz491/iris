// prompts/prompts.ts — per-user prompt preferences + global prompts.
import { and, eq, isNull } from "drizzle-orm";
import { openDb, dataFile } from "../db/sqlite.js";
import { promptPrefs } from "./schema.js";

export const { sqlite, db } = openDb(dataFile("prompts.db"));

export function migratePromptsDb(injectFailure = false): void {
  sqlite.transaction(() => {
    sqlite.exec(`
    CREATE TABLE IF NOT EXISTS prompts_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS prompt_prefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      user_id TEXT,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS prompt_prefs_key_idx ON prompt_prefs(key);
    -- required by setPrompt's onConflictDoUpdate
    CREATE UNIQUE INDEX IF NOT EXISTS prompt_prefs_key_user_idx ON prompt_prefs(key, user_id);
  `);
    if (injectFailure) throw new Error("injected migration failure");
    sqlite
      .prepare("INSERT OR IGNORE INTO prompts_schema_migrations(version, applied_at) VALUES (1, ?)")
      .run(Date.now());
  })();
}

/** Get a prompt: user-specific if set, otherwise the global one. */
export async function getPrompt(key: string, userId?: string): Promise<string | null> {
  if (userId) {
    const [u] = await db
      .select()
      .from(promptPrefs)
      .where(and(eq(promptPrefs.key, key), eq(promptPrefs.userId, userId)));
    if (u) return u.value;
  }
  const [g] = await db
    .select()
    .from(promptPrefs)
    .where(and(eq(promptPrefs.key, key), isNull(promptPrefs.userId)));
  return g?.value ?? null;
}

/** Set a user-specific or global (userId omitted) prompt. */
export async function setPrompt(key: string, value: string, userId?: string): Promise<void> {
  await db
    .insert(promptPrefs)
    .values({ key, userId: userId ?? null, value })
    .onConflictDoUpdate({
      target: [promptPrefs.key, promptPrefs.userId],
      set: { value },
    });
}

export async function deletePrompt(key: string, userId?: string): Promise<void> {
  await db
    .delete(promptPrefs)
    .where(and(eq(promptPrefs.key, key), userId ? eq(promptPrefs.userId, userId) : isNull(promptPrefs.userId)));
}
