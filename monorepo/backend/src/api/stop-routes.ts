import type { Hono } from "hono";
import type { ParticipantId } from "../chat/types.js";
import { UnauthorizedError } from "../misc/error.js";
import { z } from "zod";

export const stopChatSchema = z.object({ participantId: z.string().min(1).max(256).optional() }).strict();

export interface StopRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseChatId: (value: string) => string;
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  getChat: (chatId: string) => Promise<{
    replyingParticipants(): ParticipantId[];
    stopAiParticipant(participantId: ParticipantId): boolean;
  }>;
  parseStopBody: (request: Request) => Promise<{ participantId?: ParticipantId }>;
  errorResponse: (error: unknown) => Response;
}

/** Register the explicit stop-generation endpoint. */
export function registerStopRoutes(app: Hono, deps: StopRouteDeps): void {
  app.post("/chats/:chatId/stop", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      const chat = await deps.getChat(chatId);
      const body = await deps.parseStopBody(c.req.raw);
      const targets = body.participantId ? [body.participantId] : chat.replyingParticipants();
      const stopped = targets.filter((id) => chat.stopAiParticipant(id));
      return c.json({ stopped }, 200);
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
