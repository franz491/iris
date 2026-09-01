// memory/schema.ts — 4 memory types: agent, behavior, self, routine.
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    /** "agent" | "behavior" | "self" | "routine" */
    type: text("type").notNull(),
    keyword: text("keyword").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
    isPrivate: integer("is_private", { mode: "boolean" }).notNull().default(false),
    /** owner user id for private memories */
    ownerUserId: text("owner_user_id"),
    /** shared id linking the keyword rows of one memory */
    groupId: text("group_id"),
  },
  (t) => [index("memories_type_keyword_idx").on(t.type, t.keyword)],
);
