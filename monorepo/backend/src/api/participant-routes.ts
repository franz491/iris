import type { Hono } from "hono";
import type { NewParticipant } from "../chat/database.js";
import type { ChatSettings, Participant } from "../chat/types.js";
import { NotFoundError, UnauthorizedError, ValidationError } from "../misc/error.js";
import { z } from "zod";

export const addParticipantSchema = z
  .object({
    role: z.enum(["user", "ai"]).optional(),
    name: z.string().trim().min(1).max(256).optional(),
    model: z.string().trim().min(1).max(512).optional(),
    apiRouter: z.string().trim().min(1).max(128).optional(),
    maxContext: z.number().int().positive().max(1_000_000).optional(),
    prompt: z.string().max(1_000_000).optional(),
    cardId: z.string().min(1).max(256).optional(),
  })
  .strict();
export const participantPatchSchema = z.object({ readsOthersThoughts: z.boolean() }).strict();
export const chatSettingsPatchSchema = z
  .object({
    userInterruptions: z.boolean().optional(),
    aiInterruptions: z.boolean().optional(),
    forceAiReply: z.boolean().optional(),
  })
  .strict();

export interface ParticipantPayload {
  role?: "user" | "ai";
  name?: string;
  userId?: string;
  model?: string;
  apiRouter?: string;
  maxContext?: number;
  prompt?: string;
  cardId?: string;
}

export interface ParticipantRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseChatId: (value: string) => string;
  parseParticipantId: (value: string) => string;
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  parseAddBody: (request: Request) => Promise<ParticipantPayload>;
  parsePatchBody: (request: Request) => Promise<{ readsOthersThoughts: boolean }>;
  parseSettingsBody: (request: Request) => Promise<Partial<ChatSettings>>;
  findUserByName: (name: string) => { id: string; name: string; image?: string } | undefined;
  getUserImage: (userId: string) => string | undefined;
  addParticipant: (chatId: string, participant: NewParticipant) => Promise<Participant>;
  getParticipants: (chatId: string) => Promise<Participant[]>;
  updateAiParticipant: (participantId: string, patch: { readsOthersThoughts: boolean }) => Promise<void>;
  getChat: (chatId: string) => Promise<{ setSettings: (patch: Partial<ChatSettings>) => Promise<ChatSettings> }>;
  evictChat: (chatId: string) => void;
  errorResponse: (error: unknown) => Response;
}

/** Register participant management and chat settings mutations. */
export function registerParticipantRoutes(app: Hono, deps: ParticipantRouteDeps): void {
  app.post("/chats/:chatId/participants", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      const body = await deps.parseAddBody(c.req.raw);
      if (body.role === "ai") {
        if (!body.name?.trim()) return deps.errorResponse(new ValidationError("AI name is required"));
        const participant = await deps.addParticipant(chatId, {
          role: "ai",
          name: body.name.trim(),
          model: body.model ?? "default",
          apiRouter: body.apiRouter ?? "llamacpp",
          maxContext: body.maxContext,
          prompt: body.prompt ?? "",
          cardId: body.cardId,
        });
        return c.json(participant, 201);
      }
      const name = body.name?.trim();
      if (!name) return deps.errorResponse(new ValidationError("username is required"));
      const user = deps.findUserByName(name.replace(/@iris\.local$/, ""));
      if (!user) return deps.errorResponse(new ValidationError(`no registered user named "${name}"`));
      const participant = await deps.addParticipant(chatId, {
        role: "user",
        name: user.name,
        userId: user.id,
        avatar: deps.getUserImage(user.id) ?? undefined,
      });
      return c.json(participant, 201);
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.patch("/chats/:chatId/participants/:participantId", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      const participantId = deps.parseParticipantId(c.req.param("participantId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      const body = await deps.parsePatchBody(c.req.raw);
      const target = (await deps.getParticipants(chatId)).find((p) => p.id === participantId && p.role === "ai");
      if (!target) throw new NotFoundError(`ai participant ${participantId}`);
      await deps.updateAiParticipant(participantId, { readsOthersThoughts: body.readsOthersThoughts });
      deps.evictChat(chatId);
      return c.json({ ok: true });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.patch("/chats/:chatId/settings", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      const body = await deps.parseSettingsBody(c.req.raw);
      const settings = await (await deps.getChat(chatId)).setSettings(body);
      return c.json(settings);
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
