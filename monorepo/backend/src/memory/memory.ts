// memory/memory.ts — access to the 3(+1) types of memory.
import {
  selectMemories,
  insertMemory,
  deleteMemory,
  listAllKeywords,
  privateMemoryViewer,
  type MemoryRow,
  type MemoryType,
} from "./sql.js";
import type { ChatId, UserId } from "../chat/types.js";

export { MEMORY_TYPES } from "./sql.js";
export type { MemoryRow, MemoryType };

/** All memory keywords of a certain memory type (visible in the chat). */
export async function listKeywords(chatId: ChatId, type: MemoryType): Promise<string[]> {
  return listAllKeywords(chatId, type);
}

/** All memories of that type with the specified keyword. */
export async function listMemories(chatId: ChatId, type: MemoryType, keywords: string[]): Promise<MemoryRow[]> {
  return selectMemories(chatId, type, keywords);
}

/** Adds a new memory (one or more keywords) to one of the memory types. */
export async function addMemory(
  chatId: ChatId,
  m: {
    type: MemoryType;
    keywords: string[];
    content: string;
    isPrivate: boolean;
    /** required when private: the user storing it */
    ownerUserId?: UserId;
  },
): Promise<MemoryRow> {
  if (m.isPrivate) {
    const viewer = await privateMemoryViewer(chatId);
    if (!viewer || viewer !== m.ownerUserId) {
      throw new Error("private memories require the single human user of the chat as owner");
    }
  }
  return insertMemory({ ...m, keywords: m.keywords });
}

/** Deletes a memory. */
export async function removeMemory(id: string): Promise<void> {
  await deleteMemory(id);
}
