import type { Hono } from "hono";
import { UnauthorizedError } from "../misc/error.js";

export interface CompactionRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseChatId: (value: string) => string;
  parseParticipantId: (value: string) => string;
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  getChat: (chatId: string) => Promise<{ getParticipants: () => Promise<unknown[]> }>;
  compactionProgress: (chatId: string, participants: unknown[]) => Promise<unknown>;
  compactChat: (participant: unknown) => Promise<void>;
  errorResponse: (error: unknown) => Response;
}

/** Register chat-scoped compaction progress and execution endpoints. */
export function registerCompactionRoutes(app: Hono, deps: CompactionRouteDeps): void {
  app.get("/chats/:chatId/compaction", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) {
        throw new UnauthorizedError("not in this chat");
      }
      const chat = await deps.getChat(chatId);
      const parts = (await chat.getParticipants()).filter((participant) => {
        return (participant as { role?: string }).role === "ai";
      });
      return c.json({ progress: await deps.compactionProgress(chatId, parts) });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.post("/chats/:chatId/compact/:participantId", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      const participantId = deps.parseParticipantId(c.req.param("participantId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) {
        throw new UnauthorizedError("not in this chat");
      }
      const chat = await deps.getChat(chatId);
      const participant = (await chat.getParticipants()).find(
        (candidate) => (candidate as { id?: string; role?: string }).id === participantId,
      );
      if (!participant || (participant as { role?: string }).role !== "ai") {
        return deps.errorResponse(new Error("AI participant not found"));
      }
      await deps.compactChat(participant);
      return c.json({ ok: true });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
