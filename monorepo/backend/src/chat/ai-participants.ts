// chat/ai-participants.ts — abstraction for AI participants.
import { and, asc, desc, eq, gt, gte, lte } from "drizzle-orm";
import { chatDb as db, getParticipantsRows, hydrateRecipients, updateAiParticipant } from "./database.js";
import { messages, participants } from "./schema.js";
import type { ChatContext, ChatContentPart, ChatId, ChatParticipantAi, Message, ParticipantId } from "./types.js";
import { eventRecord, logger } from "../misc/logging.js";
import { routeCompletionOnce } from "../model-router/model-manager.js";
import { kernel } from "../runtime/kernel.js";
import { readRuntimeLimits } from "../config/runtime-limits.js";

const log = logger("chat");

const MAX_PAGE = 500;

/** Bound persisted provider tool-call batches before parsing them. */
export const MAX_STORED_TOOL_CALL_BYTES = 256 * 1024;

/** Bound persisted provider tool results before parsing them. */
export const MAX_STORED_TOOL_RESULT_BYTES = 256 * 1024;

interface StoredToolCall {
  name: string;
  arguments: string;
}

function parseStoredToolCalls(raw: string): StoredToolCall[] {
  const limits = readRuntimeLimits();
  if (Buffer.byteLength(raw, "utf8") > readRuntimeLimits().toolStorageBytes) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter((call): call is StoredToolCall => {
    if (call === null || typeof call !== "object" || Array.isArray(call)) return false;
    const candidate = call as { name?: unknown; arguments?: unknown };
    return (
      typeof candidate.name === "string" &&
      candidate.name.length > 0 &&
      typeof candidate.arguments === "string" &&
      Buffer.byteLength(candidate.arguments, "utf8") <= limits.toolArgumentBytes
    );
  });
}

function parseStoredToolResult(raw: string): { result?: unknown } | null {
  if (Buffer.byteLength(raw, "utf8") > readRuntimeLimits().toolStorageBytes) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return parsed as { result?: unknown };
}

/**
 * Get the AI participant's view of the context: all messages after its last
 * compaction (paged at 500 per query), prefixed with the compactedContext.
 */
export async function getContextForAi(chatId: ChatId, participant: ChatParticipantAi): Promise<ChatContext> {
  const after = participant.lastCompactedMessageId ?? null;
  let msgs: RawMessage[];
  if (!after) {
    msgs = await queryAllMessages(chatId);
  } else {
    const ref = await resolveCompactionMessage(chatId, after);
    // Old releases accidentally stored an ISO timestamp here. If even that
    // timestamp cannot be resolved, retaining the full history is safer than
    // making the chat unusable.
    if (!ref) {
      log.warn(JSON.stringify(eventRecord("chat", "compaction.cursor_invalid", { outcome: "full_history" }, "warn")));
      msgs = await queryAllMessages(chatId);
    } else {
      msgs = await queryAllMessagesAfter(chatId, ref);
    }
  }
  const context: ChatContext = [];
  if (participant.compactedContext) {
    context.push({ role: "system", content: participant.compactedContext });
  }
  if (participant.prompt) {
    context.push({ role: "system", content: participant.prompt });
  }
  const roles = await authorRoles(chatId);
  const canRead = roleLookup(roles);
  const toolResultCallIds = mapToolResultCallIds(msgs);
  context.push({ role: "system", content: participantRoster(roles, participant.name) });
  for (const m of msgs) {
    if (!canReadMessage(m, participant.id, canRead)) continue;
    context.push(
      await resolveMessageEntry(
        chatId,
        m,
        roles.get(m.authorId),
        participant.apiRouter === "llamacpp",
        toolResultCallIds.get(m.id),
      ),
    );
  }
  return finalizeContext(context);
}

/**
 * Fuse every system entry into ONE message at the TOP of the context
 * (original relative order preserved). Some OpenAI-compatible servers choke
 * on multiple or non-leading system messages, so the prompt always carries
 * exactly one leading system turn.
 */
export function systemMessagesFirst(ctx: ChatContext): ChatContext {
  const systems = ctx.filter((e) => e.role === "system");
  if (systems.length === 0) return [...ctx];
  const fused = systems
    .map((e) => (typeof e.content === "string" ? e.content : JSON.stringify(e.content)))
    .join("\n\n");
  return [{ role: "system", content: fused }, ...ctx.filter((e) => e.role !== "system")];
}

function finalizeContext(ctx: ChatContext): ChatContext {
  return mergeConsecutiveTurns(systemMessagesFirst(ctx));
}

/** image file extensions the backend can hand to vision models */
const IMAGE_EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};

const AUDIO_EXTENSIONS = new Set(["wav", "mp3", "flac", "ogg", "m4a", "aac"]);

/** Filename if this message is an uploaded image file, else null. */
export function imageFileName(m: Message): string | null {
  if (m.type !== "file") return null;
  const name = m.content.replace(/^\[file\]\s*/, "").trim();
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXT_MIME[ext] ? name : null;
}

/** Filename if this message is an uploaded audio file, else null. */
export function audioFileName(m: Message): string | null {
  if (m.type !== "file") return null;
  const name = m.content.replace(/^\[file\]\s*/, "").trim();
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.has(ext) ? name : null;
}

/**
 * Read an uploaded chat image from the files provider sandbox and return it
 * as a data URI; null when the file is missing/unreadable.
 */
async function imageDataUri(chatId: ChatId, filename: string): Promise<string | null> {
  try {
    const res = await kernel.useProviderContract("files.read_file", {
      filename: `chats/${chatId}/${filename}`,
      encoding: "base64",
    });
    const ext = filename.split(".").pop()!.toLowerCase();
    return `data:${IMAGE_EXT_MIME[ext]};base64,${res.content}`;
  } catch (e) {
    log.warn(JSON.stringify(eventRecord("chat", "attachment.image_unreadable", { outcome: "text_fallback" }, "warn")));
    return null;
  }
}

async function audioBase64(chatId: ChatId, filename: string): Promise<string | null> {
  try {
    const res = await kernel.useProviderContract("files.read_file", {
      filename: `chats/${chatId}/${filename}`,
      encoding: "base64",
    });
    return res.content;
  } catch {
    log.warn(JSON.stringify(eventRecord("chat", "attachment.audio_unreadable", { outcome: "text_fallback" }, "warn")));
    return null;
  }
}

/**
 * Convert a stored message into a context entry; image file messages become
 * OpenAI-style multimodal content parts so vision models see the picture.
 */
async function resolveMessageEntry(
  chatId: ChatId,
  m: Message,
  authorRole: AuthorInfo | undefined,
  allowAudio: boolean,
  toolCallId?: string,
): Promise<ChatContext[number]> {
  const img = imageFileName(m);
  if (img) {
    const url = await imageDataUri(chatId, img);
    if (url) {
      const parts: ChatContentPart[] = [
        { type: "text", text: `${authorNamePrefix(authorRole)}[image] ${img}` },
        { type: "image_url", image_url: { url } },
      ];
      return authorRole?.role === "ai" ? { role: "assistant", content: parts } : { role: "user", content: parts };
    }
  }
  const audio = allowAudio ? audioFileName(m) : null;
  if (audio) {
    const data = await audioBase64(chatId, audio);
    if (data) {
      const format = audio.split(".").pop()!.toLowerCase();
      const parts: ChatContentPart[] = [
        { type: "text", text: `${authorNamePrefix(authorRole)}[audio] ${audio}` },
        { type: "input_audio", input_audio: { data, format } },
      ];
      return authorRole?.role === "ai" ? { role: "assistant", content: parts } : { role: "user", content: parts };
    }
  }
  return messageToContextEntry(m, authorRole, toolCallId);
}

/** Pair each persisted result row with the corresponding call in the nearest
 * preceding tool batch by the same author. Tool result rows do not store the
 * provider's transient call ID, so stable message-id + batch-index IDs are
 * reconstructed here for both sides of the OpenAI exchange. */
function mapToolResultCallIds(msgs: Message[]): Map<string, string> {
  const pending = new Map<string, string[]>();
  const out = new Map<string, string>();
  for (const m of msgs) {
    if (m.type === "tool") {
      const calls = parseStoredToolCalls(m.content);
      pending.set(
        m.authorId,
        calls.map((_, i) => `iris-${m.id}-${i}`),
      );
    } else if (m.type === "tool_result") {
      const ids = pending.get(m.authorId);
      const id = ids?.shift();
      if (id) out.set(m.id, id);
      if (ids?.length === 0) pending.delete(m.authorId);
    } else {
      pending.delete(m.authorId);
    }
  }
  return out;
}

/**
 * System line listing everyone present in the chat. Regenerated on every
 * request so newly added participants are always known to the AI.
 */
function participantRoster(roles: Map<string, AuthorInfo>, selfName?: string): string {
  const list = [...roles.values()].map((a) => `${a.name} (${a.role === "ai" ? "AI" : "human user"})`);
  const self = selfName ? ` You are ${selfName}.` : "";
  const addressing = roles.size >= 3 ? " Users can be addressed/tagged with @name." : "";
  return `Participants in this chat: ${list.join(", ")}.${self}${addressing}`;
}

interface AuthorInfo {
  role: "user" | "ai";
  name: string;
}

/** participantId -> role + display name map for a chat. */
/**
 * Readability of a whisper (.to set), per viewer:
 * - broadcasts are readable by everyone
 * - the sender and every tagged recipient can always read their whispers
 * - AI -> AI whispers are additionally readable by ALL humans (observing
 *   the AIs talk is fine) but by NO other AI
 * - whispers involving a human (to or from) are readable ONLY by sender
 *   and recipients
 * Compaction entries are bookkeeping and stay visible to everyone.
 */
export function canReadMessage(
  m: Pick<Message, "to" | "authorId" | "type">,
  viewerId: ParticipantId | null,
  roleOf: (participantId: string) => "user" | "ai" | undefined,
): boolean {
  if (!m.to || m.to.length === 0 || m.type === "compaction") return true;
  if (viewerId !== null && (m.to.includes(viewerId) || m.authorId === viewerId)) return true;
  const authorRole = roleOf(m.authorId);
  const recipientsAllAi = m.to.every((rid) => roleOf(rid) === "ai");
  // AI->AI whispers are observable by humans but by no other AI
  return authorRole === "ai" && recipientsAllAi && roleOf(viewerId ?? "") !== "ai";
}

/** Build the role lookup used by canReadMessage from a participants map. */
export function roleLookup(roles: Map<string, AuthorInfo>): (id: string) => "user" | "ai" | undefined {
  return (id) => roles.get(id)?.role;
}

async function authorRoles(chatId: ChatId): Promise<Map<string, AuthorInfo>> {
  const rows = await db
    .select({ id: participants.id, type: participants.type, name: participants.name })
    .from(participants)
    .where(eq(participants.chatId, chatId));
  const map = new Map<string, AuthorInfo>();
  for (const r of rows) map.set(r.id, { role: r.type as "user" | "ai", name: r.name });
  return map;
}

async function queryAllMessages(chatId: ChatId): Promise<RawMessage[]> {
  const out: RawMessage[] = [];
  // paged retrieval; simple loop over ascending created_at
  let cursorCreatedAt = -1;
  while (true) {
    const rows = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.chatId, chatId), cursorCreatedAt >= 0 ? gt(messages.createdAt, cursorCreatedAt) : undefined),
      )
      .orderBy(asc(messages.seq))
      .limit(MAX_PAGE);
    out.push(...(await hydrateRecipients(rows)).map(withCreatedAtRaw));
    if (rows.length < MAX_PAGE) break;
    cursorCreatedAt = rows[rows.length - 1].createdAt;
  }
  return out;
}

type StoredMessage = typeof messages.$inferSelect;

/** Resolve both proper message-id cursors and timestamp cursors written by old builds. */
async function resolveCompactionMessage(chatId: ChatId, cursor: string): Promise<StoredMessage | null> {
  const [byId] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.id, cursor)));
  if (byId) return byId;

  const timestamp = Date.parse(cursor);
  if (!Number.isFinite(timestamp)) return null;
  const [atTimestamp] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), lte(messages.createdAt, timestamp)))
    .orderBy(desc(messages.createdAt), desc(messages.seq))
    .limit(1);
  return atTimestamp ?? null;
}

async function queryAllMessagesAfter(chatId: ChatId, ref: StoredMessage): Promise<RawMessage[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        ref.seq == null ? gt(messages.createdAt, ref.createdAt) : gt(messages.seq, ref.seq),
      ),
    )
    .orderBy(asc(messages.seq));
  return (await hydrateRecipients(rows)).map(withCreatedAtRaw);
}

function withCreatedAtRaw(m: Message): RawMessage {
  return { ...m, createdAtRaw: m.createdAt.getTime() };
}

/**
 * Retrieve all messages from the earliest compaction of all AIs to now,
 * inserting other AIs' compaction points as directed messages
 * (.to = [<ai id>]). Returns a function mapping an AI id to its filtered
 * ChatContext.
 */
export async function getContextForMultipleAis(
  chatId: ChatId,
  participantsList: ChatParticipantAi[],
): Promise<(id: ParticipantId) => ChatContext> {
  if (participantsList.length === 0) return () => [];
  const timestamps = new Map<ParticipantId, number>();
  for (const p of participantsList) {
    const ref = p.lastCompactedMessageId ? await resolveCompactionMessage(chatId, p.lastCompactedMessageId) : null;
    timestamps.set(p.id, ref?.createdAt ?? -1);
  }
  const earliest = Math.min(
    ...participantsList.map((p) => {
      return p.lastCompactedMessageId ? (timestamps.get(p.id) ?? -1) : -1;
    }),
  );
  const all = await queryAllMessagesAfterInclusive(chatId, earliest);

  // build a synthetic timeline where each AI's compactedContext is injected as
  // a directed "compaction" message visible only to that AI
  interface Entry {
    createdAtRaw: number;
    msg: RawMessage | null;
    authorRole?: AuthorInfo;
    compactedFor?: { ai: ChatParticipantAi };
  }
  const roles = await authorRoles(chatId);
  const canRead = roleLookup(roles);
  const toolResultCallIds = mapToolResultCallIds(all);
  const entries: Entry[] = all.map((m) => ({
    createdAtRaw: m.createdAtRaw,
    msg: m,
    authorRole: roles.get(m.authorId),
  }));
  for (const p of participantsList) {
    if (p.lastCompactedMessageId && p.compactedContext) {
      entries.push({
        createdAtRaw: timestamps.get(p.id) ?? -1,
        msg: null,
        compactedFor: { ai: p },
      });
    }
  }
  entries.sort((a, b) => a.createdAtRaw - b.createdAtRaw);

  // pre-resolve image messages into multimodal entries (async work must happen
  // before the synchronous per-AI closure below runs)
  const resolved = new Map<string, ChatContext[number]>();
  const resolvedWithoutAudio = new Map<string, ChatContext[number]>();
  for (const m of all) {
    if (imageFileName(m) || audioFileName(m)) {
      const callId = toolResultCallIds.get(m.id);
      resolved.set(m.id, await resolveMessageEntry(chatId, m, roles.get(m.authorId), true, callId));
      resolvedWithoutAudio.set(m.id, await resolveMessageEntry(chatId, m, roles.get(m.authorId), false, callId));
    }
  }

  return (id: ParticipantId) => {
    const ctx: ChatContext = [];
    const me = participantsList.find((p) => p.id === id);
    if (!me) return ctx;
    ctx.push({ role: "system", content: participantRoster(roles, me.name) });
    let started = false;
    for (const e of entries) {
      if (e.compactedFor?.ai.id === id) {
        started = true;
        ctx.push({ role: "system", content: e.compactedFor.ai.compactedContext! });
        continue;
      }
      if (!started) continue; // drop everything before my compaction point
      if (e.msg) {
        if (!canReadMessage(e.msg, id, canRead)) continue;
        if (me.readsOthersThoughts || !e.msg.thought) {
          const media = me.apiRouter === "llamacpp" ? resolved : resolvedWithoutAudio;
          ctx.push(media.get(e.msg.id) ?? messageToContextEntry(e.msg, e.authorRole, toolResultCallIds.get(e.msg.id)));
        } else {
          ctx.push({ role: "assistant", content: e.msg.content });
        }
      }
    }
    return finalizeContext(ctx);
  };
}

interface RawMessage extends Message {
  createdAtRaw: number;
}

async function queryAllMessagesAfterInclusive(chatId: ChatId, createdAt: number): Promise<RawMessage[]> {
  if (createdAt < 0) {
    return queryAllMessages(chatId);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), gte(messages.createdAt, createdAt)))
    .orderBy(asc(messages.seq));
  return (await hydrateRecipients(rows)).map(withCreatedAtRaw);
}

/** Prefix EVERY authored turn with its name so any participant can be @tagged. */
function authorNamePrefix(author: AuthorInfo | undefined): string {
  return author ? `${author.name}: ` : "";
}

/**
 * Convert a stored message into a chat-completion entry according to its
 * AUTHOR's role (user -> user, ai -> assistant), not just its type.
 * Human messages carry the author's name; tool results stay anonymous.
 */
function messageToContextEntry(m: Message, author: AuthorInfo | undefined, toolCallId?: string): ChatContext[number] {
  if (m.type === "tool") {
    const calls = parseStoredToolCalls(m.content);
    return {
      role: "assistant",
      content: null,
      tool_calls: calls.map((c, i) => ({
        id: `iris-${m.id}-${i}`,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  if (m.type === "tool_result") {
    const value = parseStoredToolResult(m.content);
    if (value) {
      return {
        role: "tool",
        tool_call_id: toolCallId ?? `iris-orphan-${m.id}`,
        content: JSON.stringify(value.result ?? value),
      };
    }
    return { role: "tool", tool_call_id: toolCallId ?? `iris-orphan-${m.id}`, content: m.content };
  }
  if (author?.role === "ai") {
    return { role: "assistant", content: `${authorNamePrefix(author)}${m.content}` };
  }
  // user authors present as user turns; unknown -> user (safe default)
  const prefix = authorNamePrefix(author);
  return {
    role: "user",
    content: `${prefix}${m.content}`,
  };
}

/**
 * Merge consecutive same-role entries into one turn.
 * Multi-AI chats can legitimately produce several assistant messages in a
 * row (double sends, tool use, AI-to-AI exchanges); some OpenAI-compatible
 * servers (llama.cpp) reject repeated trailing roles, so adjacent turns are
 * folded together without changing meaning or order.
 */
export function mergeConsecutiveTurns(ctx: ChatContext): ChatContext {
  const out: ChatContext = [];
  for (const entry of ctx) {
    const last = out[out.length - 1];
    if (
      last &&
      last.role === entry.role &&
      entry.role !== "tool" &&
      typeof last.content === "string" &&
      typeof entry.content === "string"
    ) {
      last.content = `${last.content}\n\n${entry.content}`;
    } else {
      out.push({ ...entry });
    }
  }
  return out;
}

/** Map of participantId -> estimated context usage (0..1, ~4 chars/token). */
export async function compactionProgress2(
  chatId: ChatId,
  aiParticipantsList?: ChatParticipantAi[],
): Promise<{ [k: string]: number }> {
  return compactionProgress(chatId, aiParticipantsList);
}

/** Legacy message-count based progress; kept for API compat. */
export async function compactionProgress(
  chatId: ChatId,
  aiParticipantsList?: ChatParticipantAi[],
): Promise<{ [participantId: ParticipantId]: number }> {
  const parts =
    aiParticipantsList && aiParticipantsList.length > 0
      ? aiParticipantsList
      : filterAi(await getParticipantsRows(chatId));
  const progress: { [k: ParticipantId]: number } = {};
  for (const p of parts) {
    // estimate: ~4 chars per token, over the AI's current view of the context
    const context = await getContextForAi(chatId, p);
    const tokens = context.reduce((acc, m) => {
      if (typeof m.content === "string") return acc + Math.ceil(m.content.length / 4);
      if (!m.content) return acc;
      return (
        acc +
        m.content.reduce((partTokens, part) => {
          if (part.type === "text") return partTokens + Math.ceil(part.text.length / 4);
          // Never count base64 bytes as language tokens. These conservative
          // fallbacks are used only when an API omits official usage data.
          return partTokens + (part.type === "image_url" ? 256 : 512);
        }, 0)
      );
    }, 0);
    progress[p.id] = Math.min(1, tokens / Math.max(1, p.maxContext));
  }
  return progress;
}

function filterAi(list: Awaited<ReturnType<typeof getParticipantsRows>>): ChatParticipantAi[] {
  return list.filter((p): p is ChatParticipantAi => p.role === "ai");
}

/**
 * Compact the AI's view of the chat: summarize everything after the last
 * compaction into a new compactedContext and update the DB.
 */
export async function compactChat(aiParticipant: ChatParticipantAi): Promise<void> {
  const context = await getContextForAi(aiParticipant.chatId, aiParticipant);
  // Only compact raw chat turns + tool calls/results: strip system messages
  // (participant prompt, tool docs, protocol) so instructions are not folded
  // into the summary. The previous summary is carried inside the instruction
  // instead, so its information is preserved without re-summarizing prompts.
  const conversation = context.filter((e) => e.role !== "system");
  const prev = aiParticipant.compactedContext?.trim();
  const instruction = [
    prev ? `Previous context summary:\n${prev}` : null,
    "Summarize the conversation below into a concise context document that preserves all information needed to continue the conversation seamlessly. Output only the summary.",
  ]
    .filter(Boolean)
    .join("\n\n");
  // invariant: system instruction at the TOP of the whole prompt.
  const summaryPrompt: ChatContext = [{ role: "system", content: instruction }, ...conversation];
  const { content } = await routeCompletionOnce(aiParticipant, summaryPrompt);

  // new compaction point = latest message in the AI's current view
  const latest = await latestMessageFor(aiParticipant.chatId);
  await updateAiParticipant(aiParticipant.id, {
    lastCompactedMessageId: latest?.id,
    compactedContext: content.trim(),
  });
}

async function latestMessageFor(chatId: ChatId): Promise<StoredMessage | null> {
  const [last] = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.seq), desc(messages.createdAt))
    .limit(1);
  return last ?? null;
}
