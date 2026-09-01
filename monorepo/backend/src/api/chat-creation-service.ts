import type { Hono } from "hono";
import { z } from "zod";
import type { NewParticipant } from "../chat/database.js";
import type { ChatSettings } from "../chat/types.js";
import { ValidationError } from "../misc/error.js";

export const chatParticipantSchema = z
  .object({
    role: z.enum(["user", "ai"]),
    name: z.string().trim().min(1).max(256).optional(),
    userId: z.string().min(1).max(256).optional(),
    model: z.string().trim().min(1).max(512).optional(),
    apiRouter: z.string().trim().min(1).max(128).optional(),
    maxContext: z.number().int().positive().max(1_000_000).optional(),
    apiKeyName: z.string().trim().min(1).max(256).optional(),
    prompt: z.string().max(1_000_000).optional(),
    cardId: z.string().min(1).max(256).optional(),
  })
  .strict();

// Keep the historical permissive behavior for unknown settings by stripping them,
// while making the persisted settings vocabulary explicit and typed.
export const chatSettingsSchema = z
  .object({
    userInterruptions: z.boolean().optional(),
    aiInterruptions: z.boolean().optional(),
    loadedTools: z.array(z.string().min(1).max(256)).max(256).optional(),
    forceAiReply: z.boolean().optional(),
  })
  .strip();

export const createChatSchema = z
  .object({
    participants: z.array(chatParticipantSchema).max(64).optional(),
    settings: chatSettingsSchema.optional(),
    name: z.string().trim().min(1).max(256).optional(),
  })
  .strict();

export type CreateChatPayload = z.infer<typeof createChatSchema>;
export type ResolvedChatUser = { id: string; name: string; image?: string | null };
export interface ChatCreationDeps {
  getUserName: (userId: string) => string | null;
  findUserByName: (name: string) => ResolvedChatUser | null;
  readSetupSettings: () => {
    defaultModel: { model: string; apiRouter: string; maxContext: number; apiKeyName?: string };
  };
  listRouters: () => string[];
  modelContextWindow: (router: string, model: string) => Promise<number | undefined>;
  createChat: (
    participants: NewParticipant[],
    settings?: Partial<ChatSettings>,
    name?: string,
  ) => Promise<{ id: string }>;
}

export async function normalizeChatCreation(
  userId: string,
  body: CreateChatPayload,
  deps: ChatCreationDeps,
): Promise<{ participants: NewParticipant[]; settings: Partial<ChatSettings>; name?: string }> {
  const creator = { role: "user" as const, name: deps.getUserName(userId) ?? "user", userId };
  const configuredDefault = deps.readSetupSettings().defaultModel;
  const knownRouters = new Set(deps.listRouters());
  const mapped = await Promise.all(
    [creator, ...(body.participants ?? [])].map(async (p) => {
      if (p.role === "ai") {
        const apiRouter = p.apiRouter ?? configuredDefault.apiRouter;
        if (!knownRouters.has(apiRouter)) throw new ValidationError(`unknown API router ${apiRouter}`);
        const model = p.model ?? configuredDefault.model;
        const discovered = await deps.modelContextWindow(apiRouter, model);
        return {
          role: "ai" as const,
          name: p.name ?? "AI",
          model,
          apiRouter,
          maxContext: discovered ?? (Number.isSafeInteger(p.maxContext) && p.maxContext! > 0 ? p.maxContext : 8192),
          apiKeyName:
            p.apiKeyName ??
            (apiRouter === configuredDefault.apiRouter && model === configuredDefault.model
              ? configuredDefault.apiKeyName
              : undefined),
          prompt: p.prompt ?? "",
          cardId: p.cardId,
        };
      }
      if (p.userId && p.userId !== userId)
        throw new ValidationError("user participant userId cannot be supplied for another account");
      if (p.userId === userId) return creator;
      const name = p.name?.replace(/@iris\.local$/, "").trim();
      if (!name) throw new ValidationError("username is required for added human participants");
      const user = deps.findUserByName(name);
      if (!user) throw new ValidationError(`no registered user named "${name}"`);
      return { role: "user" as const, name: user.name, userId: user.id, avatar: user.image ?? undefined };
    }),
  );
  const seen = new Set<string>();
  const participants = mapped.filter((p) => {
    if (p.role !== "user" || !p.userId) return true;
    if (seen.has(p.userId)) return false;
    seen.add(p.userId);
    return true;
  });
  return {
    participants,
    settings: chatSettingsSchema.parse(body.settings ?? {}),
    name: body.name?.trim() || undefined,
  };
}

export interface ChatCreationRouteDeps extends ChatCreationDeps {
  requireAuthenticatedUser: (request: Request) => Promise<{ userId: string }>;
  errorResponse: (error: unknown) => Response;
}

export function registerChatCreationRoutes(app: Hono, deps: ChatCreationRouteDeps): void {
  app.post("/chats", async (c) => {
    try {
      const { userId } = await deps.requireAuthenticatedUser(c.req.raw);
      const result = createChatSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!result.success) throw new ValidationError("invalid chat payload", result.error.flatten());
      const normalized = await normalizeChatCreation(userId, result.data, deps);
      const chat = await deps.createChat(normalized.participants, normalized.settings, normalized.name);
      return c.json({ chatId: chat.id }, 201);
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
