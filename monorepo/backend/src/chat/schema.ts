// chat/schema.ts — drizzle schema for chats, participants, messages.
import { sqliteTable, text, integer, primaryKey, index, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  /** display name; null -> frontend falls back to a generated label */
  name: text("name"),
});

export const participants = sqliteTable(
  "participants",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["user", "ai"] }).notNull(),
    name: text("name").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    /** when this participant joined the chat (differs from createdAt for late joiners) */
    addedAt: integer("added_at").notNull(),
  },
  (t) => [index("participants_chat_idx").on(t.chatId)],
);

export const userParticipants = sqliteTable(
  "user_participants",
  {
    participantId: text("participant_id")
      .primaryKey()
      .references(() => participants.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    /** pfp copied from the auth profile at join time; identicon fallback */
    avatar: text("avatar"),
  },
  (t) => [index("user_participants_user_idx").on(t.userId)],
);

export const aiParticipants = sqliteTable(
  "ai_participants",
  {
    participantId: text("participant_id")
      .primaryKey()
      .references(() => participants.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    apiRouter: text("api_router").notNull().default("openai-compat"),
    apiAdditionalFields: text("api_additional_fields", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    readsOthersThoughts: integer("reads_others_thoughts", { mode: "boolean" }).notNull().default(false),
    prompt: text("prompt").notNull().default(""),
    willReplyPrompt: text("will_reply_prompt").notNull().default(""),
    /** AI card this participant was created from, if any */
    cardId: text("card_id"),
    lastCompactedMessageId: text("last_compacted_message_id"),
    compactedContext: text("compacted_context"),
    maxContext: integer("max_context").notNull().default(8192),
    /** fraction of the context budget at which auto-compaction triggers */
    compactionThreshold: integer("compaction_threshold").notNull().default(80),
    /** named API key reference (see model-router/keys.ts); never the key itself */
    apiKeyName: text("api_key_name"),
  },
  (t) => [check("maxContext_positive", sql`${t.maxContext} > 0`)],
);

/** Persisted per-chat settings (survive restarts). */
export const chatSettingsTable = sqliteTable("chat_settings", {
  chatId: text("chat_id")
    .primaryKey()
    .references(() => chats.id, { onDelete: "cascade" }),
  userInterruptions: integer("user_interruptions", { mode: "boolean" }).notNull().default(true),
  aiInterruptions: integer("ai_interruptions", { mode: "boolean" }).notNull().default(false),
  /** JSON array of loaded tool group names; null = default (read_tool_info) */
  loadedTools: text("loaded_tools"),
  /** require a response instead of allowing the no-reply protocol */
  forceAiReply: integer("force_ai_reply", { mode: "boolean" }).notNull().default(false),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => participants.id),
    // "tool" | "text" | "file" | "tool_result" | "compaction"
    type: text("type").notNull(),
    thought: text("thought").notNull().default(""),
    content: text("content").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    supersededBy: text("superseded_by"),
    /** per-chat insertion sequence; timestamps can tie, this cannot */
    seq: integer("seq"),
  },
  (t) => [
    index("messages_chat_created_idx").on(t.chatId, t.createdAt, t.id),
    index("messages_author_created_idx").on(t.authorId, t.createdAt, t.id),
    index("messages_superseded_by_idx").on(t.supersededBy),
  ],
);

export const messageRecipients = sqliteTable(
  "message_recipients",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    participantId: text("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.participantId] }),
    index("message_recipients_participant_idx").on(t.participantId, t.messageId),
  ],
);

/** key/value app metadata (e.g. the universal guest chat id). */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Reusable AI personas ("cards") owned by a user. */
export const aiCards = sqliteTable(
  "ai_cards",
  {
    id: text("id").primaryKey(),
    /** owning user; cards are private to their creator */
    ownerUserId: text("owner_user_id").notNull(),
    name: text("name").notNull(),
    model: text("model").notNull().default("default"),
    apiRouter: text("api_router").notNull().default("llamacpp"),
    maxContext: integer("max_context").notNull().default(8192),
    prompt: text("prompt").notNull().default(""),
    /** seed for the identicon avatar fallback */
    avatarSeed: text("avatar_seed"),
    /** user-uploaded pfp as a data URI (identicon used when null) */
    avatar: text("avatar"),
    createdAt: integer("created_at").notNull(),
  },
  (t2) => [index("ai_cards_owner_idx").on(t2.ownerUserId)],
);
