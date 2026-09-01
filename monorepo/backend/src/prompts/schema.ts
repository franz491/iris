import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

export const promptPrefs = sqliteTable(
  "prompt_prefs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    key: text("key").notNull(),
    /** null = global prompt */
    userId: text("user_id"),
    value: text("value").notNull(),
  },
  (t) => [uniqueIndex("prompt_prefs_key_user_idx").on(t.key, t.userId)],
);
