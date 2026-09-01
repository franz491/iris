// providers/installed/memory.ts — long-term chat memory provider.
// Wraps the memory feature (memory/memory.ts) as kernel functionalities so
// the always-on `memory` AI tool group executes server-side.
//
// Every functionality requires `chatId` in kwargs (injected by the chat tool
// loop); visibility rules for private memories are enforced by the SQL layer.
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BaseProvider } from "../base.js";
import type { ProviderDescriptor } from "../types.js";
import type { ProviderConfig } from "../../runtime/types.js";
import { ValidationError } from "../../misc/error.js";
import {
  addMemory,
  listKeywords,
  listMemories,
  MEMORY_TYPES,
  removeMemory,
  type MemoryType,
} from "../../memory/memory.js";

const json = (s: z.ZodTypeAny): import("../types.js").SchemaObject =>
  zodToJsonSchema(s, { target: "openAi" }) as import("../types.js").SchemaObject;

const chatIdSchema = z.string().min(1);
const typeSchema = z.enum(MEMORY_TYPES as [MemoryType, ...MemoryType[]]);

const listKeywordsSchema = z.object({ chatId: chatIdSchema, type: typeSchema });
const listMemoriesSchema = z.object({
  chatId: chatIdSchema,
  type: typeSchema,
  keywords: z.array(z.string().min(1)).min(1),
});
const addMemorySchema = z.object({
  chatId: chatIdSchema,
  type: typeSchema,
  keywords: z.array(z.string().min(1)).min(1),
  content: z.string().min(1),
  isPrivate: z.boolean(),
  /** required when private; injected alongside chatId when the caller knows it */
  ownerUserId: z.string().optional(),
});
const removeMemorySchema = z.object({ chatId: chatIdSchema, id: z.string().min(1) });
const listKeywordsResultSchema = z.object({ keywords: z.array(z.string().min(1).max(512)).max(1024) });
const listMemoriesResultSchema = z.object({
  memories: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        keywords: z.array(z.string().min(1).max(512)).max(128),
        content: z
          .string()
          .min(1)
          .max(14 * 1024 * 1024),
        createdAt: z.string().datetime({ offset: true }),
        isPrivate: z.boolean(),
      }),
    )
    .max(4096),
});
const addMemoryResultSchema = z.object({
  ok: z.literal(true),
  id: z.string().min(1).max(256),
  keywords: z.array(z.string().min(1).max(512)).max(128),
  hint: z.string().min(1).max(1024),
});
const removeMemoryResultSchema = z.object({ ok: z.literal(true) });

export class MemoryProvider extends BaseProvider {
  readonly providerDescriptor: ProviderDescriptor = {
    name: "memory",
    description: "Long-term chat memory across four types (agent, behavior, self, routine).",
    options: [
      {
        name: "list_keywords",
        description: "List all memory keywords of one type in this chat.",
        kwargsSchema: json(listKeywordsSchema),
        returnSchema: json(listKeywordsResultSchema),
      },
      {
        name: "list_memories",
        description: "Recall memories of one type matching any keyword.",
        kwargsSchema: json(listMemoriesSchema),
        returnSchema: json(listMemoriesResultSchema),
      },
      {
        name: "add_memory",
        description: "Store a new memory under one or more keywords.",
        kwargsSchema: json(addMemorySchema),
        returnSchema: json(addMemoryResultSchema),
      },
      {
        name: "remove_memory",
        description: "Delete a memory by id.",
        kwargsSchema: json(removeMemorySchema),
        returnSchema: json(removeMemoryResultSchema),
      },
    ],
    additionalConfig: { type: "object", properties: {} },
  };

  async setConfig(newConfig: ProviderConfig): Promise<void> {
    this.config = newConfig;
    this.emit("reload");
  }

  async callFunctionality(functionality: string, kwargs: unknown): Promise<unknown> {
    if (!this.isFunctionalityActive(functionality)) {
      throw new AppErrorInactive(functionality);
    }
    switch (functionality) {
      case "list_keywords": {
        const k = listKeywordsSchema.parse(kwargs);
        return { keywords: await listKeywords(asChatId(k.chatId), k.type) };
      }
      case "list_memories": {
        const k = listMemoriesSchema.parse(kwargs);
        const rows = await listMemories(asChatId(k.chatId), k.type, k.keywords);
        return {
          memories: rows.map((r) => ({
            id: r.id,
            keywords: r.keywords,
            content: r.content,
            createdAt: r.createdAt.toISOString(),
            isPrivate: r.isPrivate,
          })),
        };
      }
      case "add_memory": {
        const k = addMemorySchema.parse(kwargs);
        const row = await addMemory(asChatId(k.chatId), {
          type: k.type,
          keywords: k.keywords,
          content: k.content,
          isPrivate: k.isPrivate,
          ownerUserId: k.ownerUserId,
        });
        return {
          ok: true,
          id: row.id,
          keywords: row.keywords,
          hint: "call list_keywords before storing to reuse existing keywords where appropriate",
        };
      }
      case "remove_memory": {
        const k = removeMemorySchema.parse(kwargs);
        await removeMemory(k.id);
        return { ok: true };
      }
      default:
        throw new ValidationError(`unknown functionality "${functionality}"`);
    }
  }
}

// small local helpers to avoid circular imports at module top-level
class AppErrorInactive extends ValidationError {
  constructor(fn: string) {
    super(`functionality "${fn}" is not active`);
  }
}

function asChatId(v: string): import("../../chat/types.js").ChatId {
  return v as import("../../chat/types.js").ChatId;
}
