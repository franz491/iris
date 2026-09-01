// memory/sql.ts — all memory SQL goes through here.
// Visibility rule: public memories are always retrievable; private memories
// only when there is exactly one human user in the chat and it is the owner.
import { and, eq, inArray } from "drizzle-orm";
import { openDb, dataFile } from "../db/sqlite.js";
import { memories } from "./schema.js";
import { countUserParticipants } from "../chat/database.js";
import type { ChatId, UserId } from "../chat/types.js";

export const { sqlite, db } = openDb(dataFile("memory.db"));

export function migrateMemoryDb(injectFailure = false): void {
  sqlite.transaction(() => {
    sqlite.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('agent','behavior','self','routine')),
      keyword TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_private INTEGER NOT NULL DEFAULT 0,
      owner_user_id TEXT
    );
    CREATE INDEX IF NOT EXISTS memories_type_keyword_idx ON memories(type, keyword);
  `);
    // memories can carry multiple keywords: one row per keyword sharing a group id
    const cols = (sqlite.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("group_id")) {
      sqlite.exec("ALTER TABLE memories ADD COLUMN group_id TEXT");
      sqlite.exec("UPDATE memories SET group_id = id WHERE group_id IS NULL");
      sqlite.exec("CREATE INDEX IF NOT EXISTS memories_group_idx ON memories(group_id)");
    }
    if (injectFailure) throw new Error("injected memory migration failure");
    sqlite.exec(
      "CREATE TABLE IF NOT EXISTS memory_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    sqlite.prepare("INSERT OR IGNORE INTO memory_schema_migrations VALUES (1, ?)").run(Date.now());
  })();
}

export type MemoryType = "agent" | "behavior" | "self" | "routine";
export type { UserId, ChatId };

export interface MemoryRow {
  /** group id: stable across the memory's keyword rows */
  id: string;
  type: MemoryType;
  /** all keywords of this memory */
  keywords: string[];
  content: string;
  createdAt: Date;
  isPrivate: boolean;
  ownerUserId?: string;
}

export const MEMORY_TYPES: MemoryType[] = ["agent", "behavior", "self", "routine"];

export function assertMemoryType(type: string): asserts type is MemoryType {
  if (!MEMORY_TYPES.includes(type as MemoryType)) {
    throw new Error(`invalid memory type: ${type}`);
  }
}

/**
 * Can private memories be retrieved in this chat, and by whom?
 * Only when the chat has exactly one human user.
 * Returns that user's id, or null.
 */
export async function privateMemoryViewer(chatId: ChatId): Promise<UserId | null> {
  const count = await countUserParticipants(chatId);
  if (count !== 1) return null;
  // single human user: find them
  const { participants, userParticipants } = await import("../chat/schema.js");
  const { chatDb } = await import("../chat/database.js");
  const rows = await chatDb
    .select({ userId: userParticipants.userId })
    .from(participants)
    .innerJoin(userParticipants, eq(userParticipants.participantId, participants.id))
    .where(eq(participants.type, "user"));
  const single = rows.find((r) => r.userId);
  return single?.userId ?? null;
}

/** All memories of a type with the given keywords, visibility-filtered for the chat. */
export async function selectMemories(chatId: ChatId, type: MemoryType, keywords: string[]): Promise<MemoryRow[]> {
  assertMemoryType(type);
  if (keywords.length === 0) return [];
  const viewer = await privateMemoryViewer(chatId);
  const conditions = [eq(memories.type, type), inArray(memories.keyword, keywords)];
  if (viewer === null) {
    conditions.push(eq(memories.isPrivate, false));
  }
  const hits = await db
    .select()
    .from(memories)
    .where(and(...conditions));
  // a memory spans several keyword rows: fetch ALL rows of the hit groups so
  // the returned keywords list is complete
  const gids = [...new Set(hits.map((r) => r.groupId ?? r.id))];
  if (gids.length === 0) return [];
  const rows = await db.select().from(memories).where(inArray(memories.groupId, gids));
  // aggregate keyword rows back into whole memories
  const byGroup = new Map<string, MemoryRow>();
  for (const r of rows) {
    if (r.isPrivate && !(viewer !== null && r.ownerUserId === viewer)) continue;
    const gid = r.groupId ?? r.id;
    const existing = byGroup.get(gid);
    if (existing) existing.keywords.push(r.keyword);
    else
      byGroup.set(gid, {
        id: gid,
        type: r.type as MemoryType,
        keywords: [r.keyword],
        content: r.content,
        createdAt: new Date(r.createdAt),
        isPrivate: r.isPrivate,
        ownerUserId: r.ownerUserId ?? undefined,
      });
  }
  return [...byGroup.values()];
}

/** Insert a memory under one or more keywords (one row per keyword). */
export async function insertMemory(m: {
  type: MemoryType;
  keywords: string[];
  content: string;
  isPrivate: boolean;
  ownerUserId?: string;
}): Promise<MemoryRow> {
  assertMemoryType(m.type);
  const kw = [...new Set(m.keywords.map((k) => k.trim()).filter(Boolean))];
  if (kw.length === 0) throw new Error("memory requires at least one keyword");
  const groupId = crypto.randomUUID();
  const createdAt = Date.now();
  await db.insert(memories).values(
    kw.map((keyword) => ({
      id: crypto.randomUUID(),
      groupId,
      type: m.type,
      keyword,
      content: m.content,
      createdAt,
      isPrivate: m.isPrivate,
      ownerUserId: m.isPrivate ? (m.ownerUserId ?? null) : null,
    })),
  );
  return {
    id: groupId,
    type: m.type,
    keywords: kw,
    content: m.content,
    createdAt: new Date(createdAt),
    isPrivate: m.isPrivate,
    ownerUserId: m.ownerUserId,
  };
}

/** Delete a whole memory (all of its keyword rows) by group id. */
export async function deleteMemory(id: string): Promise<void> {
  const { memories } = await import("./schema.js");
  const { or } = await import("drizzle-orm");
  await db.delete(memories).where(or(eq(memories.groupId, id), eq(memories.id, id)));
}

/** All distinct keywords of a type visible in the chat. */
export async function listAllKeywords(chatId: ChatId, type: MemoryType): Promise<string[]> {
  const viewer = await privateMemoryViewer(chatId);
  const rows = await db
    .select({ keyword: memories.keyword, isPrivate: memories.isPrivate, ownerUserId: memories.ownerUserId })
    .from(memories)
    .where(eq(memories.type, type));
  const visible = rows.filter((r) => !r.isPrivate || (viewer !== null && r.ownerUserId === viewer));
  return [...new Set(visible.map((r) => r.keyword))];
}
