// chat/database.ts — TS↔SQL interface for chats, participants, messages.
import { and, eq, gte, isNull, lt, sql, inArray, asc, desc } from "drizzle-orm";
import { openDb, dataFile } from "../db/sqlite.js";
import {
  chats,
  participants,
  userParticipants,
  aiParticipants,
  messages,
  messageRecipients,
  chatSettingsTable,
} from "./schema.js";
import { GUEST_USER_ID } from "./auth.js";
import { eventRecord, logger } from "../misc/logging.js";
import Database from "better-sqlite3";
const log = logger("chat-db");
import { appMeta, aiCards } from "./schema.js";
import { NotFoundError } from "../misc/error.js";
import { uuid, now } from "../misc/utils.js";
import { migrateChatDb as runChatMigrations } from "./migrations.js";
import type {
  AiParticipantBase,
  UserParticipantBase,
  Participant,
  Message,
  ChatId,
  MessageId,
  ParticipantId,
  MessageType,
  ChatSettings,
} from "./types.js";
import type { InferSelectModel } from "drizzle-orm";
type ParticipantRow = InferSelectModel<typeof participants>;
type AiParticipantRow = InferSelectModel<typeof aiParticipants>;
type AiParticipantPatch = Partial<typeof aiParticipants.$inferInsert>;
type MessageRow = InferSelectModel<typeof messages>;
type AiCardRow = InferSelectModel<typeof aiCards>;
export type AiCardInput = Partial<
  Pick<AiCardRow, "name" | "model" | "apiRouter" | "maxContext" | "prompt" | "avatarSeed" | "avatar">
> &
  Pick<AiCardRow, "name">;
export type AiCard = Omit<AiCardRow, "ownerUserId" | "createdAt" | "avatarSeed" | "avatar"> & {
  createdAt: Date;
  avatarSeed?: string;
  avatar?: string;
};
type StagedAttachment = { id: string; chatId: string; storagePath: string; createdAt: number };
export type NewParticipant =
  | (Omit<
      AiParticipantBase,
      | "id"
      | "chatId"
      | "createdAt"
      | "addedAt"
      | "apiAdditionalFields"
      | "readsOthersThoughts"
      | "willReplyPrompt"
      | "compactionThreshold"
      | "prompt"
      | "maxContext"
      | "apiRouter"
    > &
      Partial<
        Pick<
          AiParticipantBase,
          | "apiAdditionalFields"
          | "readsOthersThoughts"
          | "willReplyPrompt"
          | "compactionThreshold"
          | "prompt"
          | "maxContext"
          | "apiRouter"
        >
      >)
  | Omit<UserParticipantBase, "id" | "chatId" | "createdAt" | "addedAt">;
const { sqlite, db } = openDb(dataFile("chat.db"));
export const chatDb = db;
/** Raw handle, used for multi-statement migrations. */
export const chatSqlite = sqlite;
/** Narrow synchronous boundary for multi-statement repository operations. */
export function runChatTransaction<T>(operation: (connection: Database.Database) => T): T {
  return chatSqlite.transaction(() => operation(chatSqlite))();
}
/** Persist a new chat and all of its initial projection in one SQLite transaction. */
export function createChatAtomic(
  initialParticipants: NewParticipant[],
  settings: ChatSettings,
  name?: string,
  options: { faultAt?: (boundaryName: string) => void; onCommitted?: () => void } = {},
): ChatId {
  const chatId = uuid();
  const createdAt = now();
  runChatTransaction((c) => {
    insertChatProjection(c, chatId, createdAt, initialParticipants, settings, name, options.faultAt);
    options.faultAt?.("pre_commit");
  });
  options.onCommitted?.();
  return chatId;
}

function insertChatProjection(
  c: Database.Database,
  chatId: ChatId,
  createdAt: number,
  initialParticipants: NewParticipant[],
  settings: ChatSettings,
  name: string | undefined,
  faultAt?: (boundaryName: string) => void,
): void {
  c.prepare("INSERT INTO chats (id, created_at, name) VALUES (?, ?, ?)").run(chatId, createdAt, name ?? null);
  faultAt?.("chat_row");
  for (const p of initialParticipants) {
    const participantId = uuid();
    c.prepare("INSERT INTO participants (id, chat_id, type, name, created_at, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      participantId,
      chatId,
      p.role,
      p.name,
      createdAt,
      createdAt,
    );
    if (p.role === "ai") {
      faultAt?.("participant_ai");
      c.prepare(
        "INSERT INTO ai_participants (participant_id, model, api_router, api_additional_fields, reads_others_thoughts, prompt, will_reply_prompt, max_context, compaction_threshold, api_key_name, card_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        participantId,
        p.model,
        p.apiRouter ?? "openai-compat",
        JSON.stringify(p.apiAdditionalFields ?? {}),
        p.readsOthersThoughts ? 1 : 0,
        p.prompt ?? "",
        p.willReplyPrompt ?? "",
        p.maxContext ?? 8192,
        p.compactionThreshold ?? 80,
        p.apiKeyName ?? null,
        p.cardId ?? null,
      );
      faultAt?.("ai_subtype");
    } else {
      faultAt?.("participant_user");
      c.prepare("INSERT INTO user_participants (participant_id, user_id, avatar) VALUES (?, ?, ?)").run(
        participantId,
        p.userId ?? null,
        p.avatar ?? null,
      );
      faultAt?.("user_subtype");
    }
  }
  c.prepare(
    "INSERT INTO chat_settings (chat_id, user_interruptions, ai_interruptions, loaded_tools, force_ai_reply) VALUES (?, ?, ?, ?, ?)",
  ).run(
    chatId,
    settings.userInterruptions ? 1 : 0,
    settings.aiInterruptions ? 1 : 0,
    settings.loadedTools ? JSON.stringify(settings.loadedTools) : null,
    settings.forceAiReply ? 1 : 0,
  );
  faultAt?.("settings");
}

export type GuestChatAtomicInput = {
  userId: string;
  aiName: string;
  aiModel: string;
  apiRouter: string;
  maxContext: number;
  settings: ChatSettings;
  name?: string;
  faultAt?: (boundaryName: string) => void;
};

export type GuestChatAtomicResult = { chatId: ChatId; created: boolean; repaired: boolean };

/** Find or create the universal guest chat while holding SQLite's writer lock. */
export function ensureGuestChatAtomic(input: GuestChatAtomicInput): GuestChatAtomicResult {
  return ensureGuestChatAtomicOn(chatSqlite, input);
}

/** Same primitive for a separately opened SQLite connection (multi-process tests/tools). */
export function ensureGuestChatAtomicOn(
  connection: Database.Database,
  input: GuestChatAtomicInput,
): GuestChatAtomicResult {
  const transaction = connection.transaction(() => {
    const meta = connection.prepare("SELECT value FROM app_meta WHERE key = ?").get("guest_chat_id") as
      { value: string } | undefined;
    input.faultAt?.("lookup");
    if (meta) {
      const existing = connection.prepare("SELECT id, name FROM chats WHERE id = ?").get(meta.value) as
        { id: string; name: string | null } | undefined;
      const projection = existing
        ? (connection
            .prepare(
              `SELECT
                 COUNT(*) AS total,
                 SUM(CASE WHEN p.type = 'user' THEN 1 ELSE 0 END) AS users,
                 SUM(CASE WHEN p.type = 'user' AND up.user_id = ? THEN 1 ELSE 0 END) AS guest_users,
                 SUM(CASE WHEN p.type = 'ai' THEN 1 ELSE 0 END) AS ais,
                 SUM(CASE WHEN p.type = 'ai' AND ap.participant_id IS NOT NULL THEN 1 ELSE 0 END) AS complete_ais,
                 (SELECT COUNT(*) FROM chat_settings WHERE chat_id = ?) AS settings
               FROM participants p
               LEFT JOIN user_participants up ON up.participant_id = p.id
               LEFT JOIN ai_participants ap ON ap.participant_id = p.id
               WHERE p.chat_id = ?`,
            )
            .get(GUEST_USER_ID, existing.id, existing.id) as
            | { total: number; users: number; guest_users: number; ais: number; complete_ais: number; settings: number }
            | undefined)
        : undefined;
      const isCanonicalGuestProjection =
        !!projection &&
        projection.total === 2 &&
        projection.users === 1 &&
        projection.guest_users === 1 &&
        projection.ais === 1 &&
        projection.complete_ais === 1 &&
        projection.settings === 1;
      input.faultAt?.("projection_validation");
      if (existing && isCanonicalGuestProjection) {
        let repaired = false;
        if (!existing.name) {
          connection.prepare("UPDATE chats SET name = ? WHERE id = ?").run(input.name ?? "guest chat", existing.id);
          repaired = true;
          input.faultAt?.("name_repair");
        }
        const modelResult = connection
          .prepare(
            "UPDATE ai_participants SET model = ? WHERE participant_id = (SELECT id FROM participants WHERE chat_id = ? AND type = 'ai' ORDER BY created_at, id LIMIT 1) AND model <> ?",
          )
          .run(input.aiModel, existing.id, input.aiModel);
        if (modelResult.changes > 0) {
          repaired = true;
          input.faultAt?.("model_repair");
        }
        return { chatId: existing.id, created: false, repaired };
      }
    }
    const chatId = uuid();
    insertChatProjection(
      connection,
      chatId,
      now(),
      [
        { role: "user", name: "guest", userId: input.userId },
        {
          role: "ai",
          name: input.aiName,
          model: input.aiModel,
          apiRouter: input.apiRouter,
          maxContext: input.maxContext,
        },
      ],
      input.settings,
      input.name ?? "guest chat",
      input.faultAt,
    );
    connection
      .prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("guest_chat_id", chatId);
    input.faultAt?.("metadata");
    input.faultAt?.("pre_commit");
    return { chatId, created: true, repaired: false };
  });
  return transaction.immediate() as GuestChatAtomicResult;
}
/** Create all tables if they don't exist. */
export function migrateChatDb(): void {
  runChatMigrations(chatSqlite, {
    clock: now,
    authDbPath: dataFile("auth.db"),
    onAuthNameRepairError: () =>
      log.warn(JSON.stringify(eventRecord("chat", "auth_name_repair.failed", { outcome: "deferred" }, "warn"))),
  });
}
/** Record a file before creating it; this is the durable ownership proof used by reconciliation. */
export function stageAttachment(stage: StagedAttachment): void {
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(stage.id) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(stage.chatId) ||
    stage.storagePath !== `chats/${stage.chatId}/${stage.storagePath.split("/").slice(2).join("/")}` ||
    !/^chats\/[^/]+\/[^/]+$/.test(stage.storagePath) ||
    stage.storagePath.length > 512 ||
    !Number.isSafeInteger(stage.createdAt) ||
    stage.createdAt < 0
  ) {
    throw new Error("invalid attachment staging record");
  }
  chatSqlite
    .prepare("INSERT INTO attachment_staging(id, chat_id, storage_path, created_at) VALUES(?,?,?,?)")
    .run(stage.id, stage.chatId, stage.storagePath, stage.createdAt);
}
export function clearAttachmentStage(id: string): void {
  chatSqlite.prepare("DELETE FROM attachment_staging WHERE id=?").run(id);
}
export function attachmentMessageExists(chatId: string, storagePath: string): boolean {
  const filename = storagePath.split("/").pop();
  if (!filename) return false;
  return (
    chatSqlite
      .prepare("SELECT 1 FROM messages WHERE chat_id=? AND type='file' AND content=? LIMIT 1")
      .get(chatId, `[file] ${filename}`) !== undefined
  );
}
export function listStagedAttachments(olderThan: number): StagedAttachment[] {
  const rows = chatSqlite
    .prepare(
      "SELECT id, chat_id as chatId, storage_path as storagePath, created_at as createdAt FROM attachment_staging WHERE created_at <= ? ORDER BY created_at LIMIT 1000",
    )
    .all(olderThan);
  return (rows as unknown[]).filter((row): row is StagedAttachment => {
    if (!row || typeof row !== "object") return false;
    const r = row as Partial<StagedAttachment>;
    return (
      typeof r.id === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(r.id) &&
      typeof r.chatId === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(r.chatId) &&
      typeof r.storagePath === "string" &&
      r.storagePath.length <= 512 &&
      /^chats\/[^/]+\/[^/]+$/.test(r.storagePath) &&
      r.storagePath.startsWith(`chats/${r.chatId}/`) &&
      typeof r.createdAt === "number" &&
      Number.isSafeInteger(r.createdAt) &&
      r.createdAt >= 0
    );
  });
}
// ---------- chats ----------
export async function createChatRow(
  name?: string,
): Promise<{ id: ChatId; participants: Participant[]; createdAt: Date; name?: string }> {
  const id = uuid();
  const createdAt = now();
  await db.insert(chats).values({ id, createdAt, name: name ?? null });
  return { id, participants: [], createdAt: new Date(createdAt), name: name ?? undefined };
}
export async function getChatRow(
  chatId: ChatId,
): Promise<{ id: ChatId; participants: Participant[]; createdAt: Date; name?: string }> {
  const [row] = await db.select().from(chats).where(eq(chats.id, chatId));
  if (!row) throw new NotFoundError(`chat ${chatId}`);
  const parts = await getParticipantsRows(chatId);
  return { id: row.id, participants: parts, createdAt: new Date(row.createdAt), name: row.name ?? undefined };
}
/** Rename a chat. */
export async function renameChat(chatId: ChatId, name: string | null): Promise<void> {
  const res = await db.update(chats).set({ name }).where(eq(chats.id, chatId)).run();
  if (res.changes === 0) throw new NotFoundError(`chat ${chatId}`);
}
/** Delete a chat entirely (cascades to participants/messages). */
export async function deleteChat(chatId: ChatId): Promise<void> {
  const { evictChat } = await import("./chat.js");
  evictChat(chatId);
  const res = await db.delete(chats).where(eq(chats.id, chatId)).run();
  if (res.changes === 0) throw new NotFoundError(`chat ${chatId}`);
}
export async function insertParticipant(chatId: ChatId, p: NewParticipant): Promise<Participant> {
  const id = uuid();
  const createdAt = now();
  if (p.role === "ai") {
    runChatTransaction((c) => {
      c.prepare(
        "INSERT INTO participants (id, chat_id, type, name, created_at, added_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(id, chatId, "ai", p.name, createdAt, createdAt);
      c.prepare(
        "INSERT INTO ai_participants (participant_id, model, api_router, api_additional_fields, reads_others_thoughts, prompt, will_reply_prompt, max_context, compaction_threshold, api_key_name, card_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        p.model,
        p.apiRouter ?? "openai-compat",
        JSON.stringify(p.apiAdditionalFields ?? {}),
        p.readsOthersThoughts ? 1 : 0,
        p.prompt ?? "",
        p.willReplyPrompt ?? "",
        p.maxContext ?? 8192,
        p.compactionThreshold ?? 80,
        p.apiKeyName ?? null,
        p.cardId ?? null,
      );
    });
  }
  if (p.role === "ai") {
    return {
      chatId,
      role: "ai",
      id,
      name: p.name,
      createdAt: new Date(createdAt),
      addedAt: new Date(createdAt),
      model: p.model,
      apiRouter: p.apiRouter ?? "openai-compat",
      apiAdditionalFields: p.apiAdditionalFields ?? {},
      readsOthersThoughts: p.readsOthersThoughts ?? false,
      prompt: p.prompt ?? "",
      willReplyPrompt: p.willReplyPrompt ?? "",
      maxContext: p.maxContext ?? 8192,
      compactionThreshold: p.compactionThreshold ?? 80,
      apiKeyName: p.apiKeyName,
      cardId: p.cardId,
    };
  }
  runChatTransaction((c) => {
    c.prepare("INSERT INTO participants (id, chat_id, type, name, created_at, added_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      chatId,
      p.role,
      p.name,
      createdAt,
      createdAt,
    );
    c.prepare("INSERT INTO user_participants (participant_id, user_id, avatar) VALUES (?, ?, ?)").run(
      id,
      p.userId,
      p.avatar ?? null,
    );
  });
  return {
    chatId,
    role: "user",
    id,
    name: p.name,
    createdAt: new Date(createdAt),
    addedAt: new Date(createdAt),
    userId: p.userId,
    avatar: p.avatar,
  };
}
function rowToAiParticipant(part: ParticipantRow, ai: AiParticipantRow): AiParticipantBase {
  return {
    chatId: part.chatId,
    role: "ai",
    id: part.id,
    name: part.name,
    createdAt: new Date(part.createdAt),
    model: ai.model,
    apiRouter: ai.apiRouter,
    apiAdditionalFields: ai.apiAdditionalFields,
    readsOthersThoughts: !!ai.readsOthersThoughts,
    prompt: ai.prompt,
    willReplyPrompt: ai.willReplyPrompt,
    lastCompactedMessageId: ai.lastCompactedMessageId ?? undefined,
    compactedContext: ai.compactedContext ?? undefined,
    maxContext: ai.maxContext,
    compactionThreshold: ai.compactionThreshold,
    apiKeyName: ai.apiKeyName ?? undefined,
    cardId: ai.cardId ?? undefined,
    addedAt: new Date(part.addedAt),
  };
}
export async function getParticipantsRows(chatId: ChatId): Promise<Participant[]> {
  const rows = await db.select().from(participants).where(eq(participants.chatId, chatId));
  const out: Participant[] = [];
  for (const r of rows) {
    if (r.type === "ai") {
      const [ai] = await db.select().from(aiParticipants).where(eq(aiParticipants.participantId, r.id));
      if (ai) out.push(rowToAiParticipant(r, ai));
    } else {
      const [u] = await db.select().from(userParticipants).where(eq(userParticipants.participantId, r.id));
      out.push({
        chatId: r.chatId,
        role: "user",
        id: r.id,
        name: r.name,
        createdAt: new Date(r.createdAt),
        userId: u?.userId ?? undefined,
        addedAt: new Date(r.addedAt),
      });
    }
  }
  return out;
}
export async function getParticipant(participantId: ParticipantId): Promise<Participant> {
  const [r] = await db.select().from(participants).where(eq(participants.id, participantId));
  if (!r) throw new NotFoundError(`participant ${participantId}`);
  if (r.type === "ai") {
    const [ai] = await db.select().from(aiParticipants).where(eq(aiParticipants.participantId, r.id));
    if (!ai) throw new NotFoundError(`ai participant ${participantId}`);
    return rowToAiParticipant(r, ai);
  }
  const [u] = await db.select().from(userParticipants).where(eq(userParticipants.participantId, r.id));
  return {
    chatId: r.chatId,
    role: "user",
    id: r.id,
    name: r.name,
    createdAt: new Date(r.createdAt),
    addedAt: new Date(r.addedAt),
    userId: u?.userId ?? undefined,
    avatar: u?.avatar ?? undefined,
  };
}
export async function updateAiParticipant(participantId: ParticipantId, patch: AiParticipantPatch) {
  await db.update(aiParticipants).set(patch).where(eq(aiParticipants.participantId, participantId));
}
// ---------- messages ----------
export async function insertMessage(
  m: Omit<Message, "id" | "createdAt" | "seq"> & { id?: MessageId },
): Promise<Message> {
  const id = m.id ?? uuid();
  const createdAt = now();
  const recipients = m.to ?? [];
  // Sequence allocation and recipient insertion must share one SQLite write
  // transaction. Besides preventing duplicate seq values under concurrent
  // sends, this guarantees a failed recipient insert cannot leave a visible
  // message without its routing metadata.
  const seq = sqlite.transaction(() => {
    const row = sqlite.prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE chat_id = ?").get(m.chatId);
    const next = Number((row as { max_seq: number | null }).max_seq) + 1;
    sqlite
      .prepare(
        "INSERT INTO messages (id, chat_id, author_id, type, thought, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, m.chatId, m.authorId, m.type, m.thought, m.content, createdAt, next);
    const insertRecipient = sqlite.prepare("INSERT INTO message_recipients (message_id, participant_id) VALUES (?, ?)");
    for (const participantId of recipients) insertRecipient.run(id, participantId);
    return next;
  })();
  return { ...m, id, createdAt: new Date(createdAt), seq, to: recipients.length ? recipients : undefined };
}
/**
 * Replace one message in place and permanently delete the branch after it.
 * This is one SQLite transaction so readers never observe a rewritten message
 * with its abandoned followups still attached. Any compaction summary may
 * describe the deleted branch, so all AI cursors for the chat are reset.
 */
export async function rewriteMessageBranch(
  chatId: ChatId,
  messageId: MessageId,
  patch: Pick<Partial<Message>, "content" | "thought">,
  options: { faultAt?: (boundaryName: string) => void; onCommitted?: () => void } = {},
) {
  const [old] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.id, messageId)));
  if (!old) throw new NotFoundError(`message ${messageId}`);
  const recipients = await db
    .select({ participantId: messageRecipients.participantId })
    .from(messageRecipients)
    .where(eq(messageRecipients.messageId, messageId));
  const nextContent = patch.content ?? old.content;
  const nextThought = patch.thought ?? old.thought;
  const transaction = sqlite.transaction(() => {
    const sequence = old.seq ?? 0;
    const deleted = sqlite
      .prepare("DELETE FROM messages WHERE chat_id = ? AND (seq > ? OR (seq = ? AND id <> ?))")
      .run(chatId, sequence, sequence, messageId).changes;
    options.faultAt?.("branch_deleted");
    sqlite
      .prepare("UPDATE messages SET content = ?, thought = ?, superseded_by = NULL WHERE id = ? AND chat_id = ?")
      .run(nextContent, nextThought, messageId, chatId);
    options.faultAt?.("message_rewritten");
    sqlite
      .prepare(
        "UPDATE ai_participants SET last_compacted_message_id = NULL, compacted_context = NULL WHERE participant_id IN (SELECT id FROM participants WHERE chat_id = ?)",
      )
      .run(chatId);
    options.faultAt?.("cursors_reset");
    options.faultAt?.("pre_commit");
    return deleted;
  });
  const deletedFollowing = transaction();
  options.onCommitted?.();
  return {
    message: {
      id: old.id,
      chatId: old.chatId,
      authorId: old.authorId,
      type: old.type as MessageType,
      thought: nextThought,
      content: nextContent,
      createdAt: new Date(old.createdAt),
      seq: old.seq ?? undefined,
      to: recipients.length ? recipients.map((r) => r.participantId) : undefined,
    },
    deletedFollowing,
  };
}
/** Latest (non-superseded) messages for a chat, ascending, optionally after an id. */
export async function getMessagesSinceId(
  chatId: ChatId,
  lastMessage: MessageId | null,
  limit = 500,
): Promise<Message[]> {
  let afterCreatedAt = 0;
  if (lastMessage) {
    const [ref] = await db.select().from(messages).where(eq(messages.id, lastMessage));
    if (ref) afterCreatedAt = ref.createdAt;
    // unknown lastMessageId (e.g. client seed) -> treat as "from the beginning"
  }
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        isNull(messages.supersededBy),
        lastMessage ? gte(messages.createdAt, afterCreatedAt) : undefined,
      ),
    )
    .orderBy(asc(messages.seq))
    .limit(limit + (lastMessage ? 1 : 0));
  const filtered = lastMessage ? rows.filter((r) => r.id !== lastMessage && r.createdAt > afterCreatedAt) : rows;
  const recent = filtered.slice(-limit);
  return hydrateRecipients(recent);
}
export async function hydrateRecipients(rows: MessageRow[]): Promise<Message[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const recips = await db.select().from(messageRecipients).where(inArray(messageRecipients.messageId, ids));
  const byMessage = new Map<string, ParticipantId[]>();
  for (const r of recips) {
    const arr = byMessage.get(r.messageId) ?? [];
    arr.push(r.participantId);
    byMessage.set(r.messageId, arr);
  }
  return rows.map((r) => ({
    id: r.id,
    chatId: r.chatId,
    authorId: r.authorId,
    type: r.type as MessageType,
    thought: r.thought,
    content: r.content,
    createdAt: new Date(r.createdAt),
    to: byMessage.get(r.id),
  }));
}
export async function getMessage(messageId: MessageId): Promise<Message> {
  const [r] = await db.select().from(messages).where(eq(messages.id, messageId));
  if (!r) throw new NotFoundError(`message ${messageId}`);
  const [hydrated] = await hydrateRecipients([r]);
  return hydrated;
}
export async function countUserParticipants(chatId: ChatId): Promise<number> {
  const [row] = await db
    .select({ count: sql`count(*)` })
    .from(participants)
    .where(and(eq(participants.chatId, chatId), eq(participants.type, "user")));
  return Number(row.count);
}
function rowToCard(r: AiCardRow): AiCard {
  return {
    id: r.id,
    name: r.name,
    model: r.model,
    apiRouter: r.apiRouter,
    maxContext: r.maxContext,
    prompt: r.prompt,
    avatarSeed: r.avatarSeed ?? undefined,
    avatar: r.avatar ?? undefined,
    createdAt: new Date(r.createdAt),
  };
}
export async function listAiCards(ownerUserId: string): Promise<AiCard[]> {
  const rows = await db.select().from(aiCards).where(eq(aiCards.ownerUserId, ownerUserId));
  return rows.sort((a, b) => a.createdAt - b.createdAt).map(rowToCard);
}
export async function createAiCard(ownerUserId: string, c: AiCardInput): Promise<AiCard> {
  const id = uuid();
  const createdAt = now();
  await db.insert(aiCards).values({
    id,
    ownerUserId,
    name: c.name,
    model: c.model ?? "default",
    apiRouter: c.apiRouter ?? "llamacpp",
    maxContext: c.maxContext ?? 8192,
    prompt: c.prompt ?? "",
    avatarSeed: c.avatarSeed ?? id,
    avatar: c.avatar ?? null,
    createdAt,
  });
  return {
    id,
    name: c.name,
    model: c.model ?? "default",
    apiRouter: c.apiRouter ?? "llamacpp",
    maxContext: c.maxContext ?? 8192,
    prompt: c.prompt ?? "",
    avatarSeed: c.avatarSeed ?? id,
    avatar: c.avatar ?? undefined,
    createdAt: new Date(createdAt),
  };
}
/** Apply a card's current identity to every chat participant created from it. */
export async function propagateCard(
  cardId: string,
  identity: Pick<AiCardRow, "name" | "model" | "apiRouter" | "maxContext" | "prompt">,
  options: { faultAt?: (boundaryName: string) => void; onCommitted?: () => void } = {},
): Promise<number> {
  // Name lives on the shared participant row; the remaining identity fields
  // live on its AI extension. Keep both projections in one write transaction.
  const changed = sqlite.transaction(() => {
    sqlite
      .prepare(
        "UPDATE participants SET name = ? WHERE type = 'ai' AND id IN (SELECT participant_id FROM ai_participants WHERE card_id = ?)",
      )
      .run(identity.name, cardId);
    options.faultAt?.("participant_names");
    const changed = sqlite
      .prepare("UPDATE ai_participants SET model = ?, api_router = ?, max_context = ?, prompt = ? WHERE card_id = ?")
      .run(identity.model, identity.apiRouter, identity.maxContext, identity.prompt, cardId).changes;
    options.faultAt?.("ai_identity");
    options.faultAt?.("pre_commit");
    return changed;
  })();
  options.onCommitted?.();
  return changed;
}
export async function updateAiCard(
  ownerUserId: string,
  id: string,
  patch: Partial<typeof aiCards.$inferInsert>,
): Promise<AiCard | null> {
  const res = await db
    .update(aiCards)
    .set(patch)
    .where(and(eq(aiCards.id, id), eq(aiCards.ownerUserId, ownerUserId)))
    .run();
  if (res.changes === 0) return null; // not found or not the owner
  const [row] = await db.select().from(aiCards).where(eq(aiCards.id, id));
  return row ? rowToCard(row) : null;
}
export async function deleteAiCard(ownerUserId: string, id: string): Promise<boolean> {
  const res = await db
    .delete(aiCards)
    .where(and(eq(aiCards.id, id), eq(aiCards.ownerUserId, ownerUserId)))
    .run();
  return res.changes > 0;
}
// ---------- app metadata (key/value) ----------
export async function getAppMeta(key: string): Promise<string | null> {
  const [row] = await db.select().from(appMeta).where(eq(appMeta.key, key));
  return row?.value ?? null;
}
export async function setAppMeta(key: string, value: string): Promise<void> {
  await db.insert(appMeta).values({ key, value }).onConflictDoUpdate({ target: appMeta.key, set: { value } });
}
/** Wipe all messages of a chat and reset AI compaction state ("delete context"). */
export async function clearChatContext(chatId: ChatId): Promise<void> {
  sqlite.transaction(() => {
    sqlite.prepare("DELETE FROM messages WHERE chat_id = ?").run(chatId);
    sqlite.prepare("UPDATE ai_participants SET last_compacted_message_id = NULL, compacted_context = NULL").run();
  })();
}
// ---------- per-chat settings ----------
const MAX_LOADED_TOOLS = 256;
const MAX_LOADED_TOOL_NAME_LENGTH = 256;
function parseLoadedTools(value: string): string[] | undefined {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > MAX_LOADED_TOOLS) return undefined;
    if (
      !parsed.every((tool) => typeof tool === "string" && tool.length > 0 && tool.length <= MAX_LOADED_TOOL_NAME_LENGTH)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
export async function loadChatSettings(chatId: ChatId): Promise<ChatSettings | null> {
  const [row] = await db.select().from(chatSettingsTable).where(eq(chatSettingsTable.chatId, chatId));
  if (!row) return null;
  let loadedTools;
  if (row.loadedTools) {
    loadedTools = parseLoadedTools(row.loadedTools);
  }
  return {
    userInterruptions: row.userInterruptions,
    aiInterruptions: row.aiInterruptions,
    loadedTools,
    forceAiReply: row.forceAiReply,
  };
}
export async function saveChatSettings(chatId: ChatId, s: ChatSettings): Promise<void> {
  await db
    .insert(chatSettingsTable)
    .values({
      chatId,
      userInterruptions: s.userInterruptions,
      aiInterruptions: s.aiInterruptions,
      loadedTools: s.loadedTools ? JSON.stringify(s.loadedTools) : null,
      forceAiReply: s.forceAiReply ?? false,
    })
    .onConflictDoUpdate({
      target: chatSettingsTable.chatId,
      set: {
        userInterruptions: s.userInterruptions,
        aiInterruptions: s.aiInterruptions,
        loadedTools: s.loadedTools ? JSON.stringify(s.loadedTools) : null,
        forceAiReply: s.forceAiReply ?? false,
      },
    });
}
/** Chats a user belongs to, with their membership timestamp.
 * Guests intentionally match nothing: their only chat is the universal
 * guest chat, delivered via GET /api/chats/guest.
 */
export async function getUserChatMemberships(
  userId: string,
): Promise<Array<{ chatId: ChatId; chatCreatedAt: number; addedAt: number; chatName: string | null }>> {
  if (userId === GUEST_USER_ID) return [];
  const rows = await db
    .select({
      chatId: participants.chatId,
      chatCreatedAt: chats.createdAt,
      addedAt: participants.addedAt,
      chatName: chats.name,
    })
    .from(participants)
    .innerJoin(userParticipants, eq(userParticipants.participantId, participants.id))
    .innerJoin(chats, eq(chats.id, participants.chatId))
    .where(and(eq(participants.type, "user"), eq(userParticipants.userId, userId)));
  return rows;
}
/** Cap a chat's history to the newest `keep` messages (guest chat hygiene). */
export async function pruneOldMessages(chatId: ChatId, keep: number): Promise<number> {
  const newest = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.seq))
    .limit(keep);
  const keepIds = new Set(newest.map((r) => r.id));
  const all = await db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId));
  const stale = all.filter((r) => !keepIds.has(r.id)).map((r) => r.id);
  if (stale.length === 0) return 0;
  await db.delete(messages).where(inArray(messages.id, stale));
  return stale.length;
}
/** Delete a message and every message of the chat that came after it. */
export async function deleteMessageAndFollowing(chatId: ChatId, messageId: MessageId): Promise<number> {
  const [ref] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.id, messageId)));
  if (!ref) throw new NotFoundError(`message ${messageId}`);
  const following = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), gte(messages.seq, ref.seq ?? 0)))
    .orderBy(asc(messages.seq));
  const ids = following.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(messages).where(inArray(messages.id, ids));
  }
  return ids.length;
}
/** Add a participant to an existing chat (human or AI). */
export async function addParticipant(chatId: ChatId, p: NewParticipant): Promise<Participant> {
  return insertParticipant(chatId, p);
}
/** One page of history ending just before `beforeSeq` (exclusive), oldest-last. */
export async function getHistoryPage(
  chatId: ChatId,
  beforeSeq: number | null,
  limit: number,
): Promise<{ messages: Message[]; hasMore: boolean; oldestSeq: number | null }> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        isNull(messages.supersededBy),
        beforeSeq !== null ? lt(messages.seq, beforeSeq) : undefined,
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return {
    messages: await hydrateRecipients(page),
    hasMore,
    oldestSeq: page.length > 0 ? (page[0].seq ?? null) : null,
  };
}
