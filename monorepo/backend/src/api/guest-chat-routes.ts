import type { Hono } from "hono";
import { UnauthorizedError } from "../misc/error.js";
import type { GuestChatAtomicResult } from "../chat/database.js";

export interface GuestChatRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string; isGuest: boolean }>;
  getSource: (request: Request) => string | undefined;
  consumeAccess: (key: string, limit: number) => number | undefined;
  accessLimit: number;
  rateLimitResponse: (retryAfter: number) => Response;
  readConfig: () => { guestAiName: string; guestModel: string };
  readDefaultModel: () => Promise<{ model: string; apiRouter: string; maxContext: number }>;
  ensureGuestChat: (input: {
    userId: string;
    aiName: string;
    aiModel: string;
    apiRouter: string;
    maxContext: number;
  }) => GuestChatAtomicResult;
  errorResponse: (error: unknown) => Response;
}

export function registerGuestChatRoutes(app: Hono, deps: GuestChatRouteDeps): void {
  app.get("/chats/guest", async (c) => {
    try {
      const { userId, isGuest } = await deps.requireUser(c.req.raw);
      if (!isGuest) throw new UnauthorizedError("guest chat is for guests");
      const source = deps.getSource(c.req.raw) ?? "unknown";
      const retryAfter = deps.consumeAccess(`access:source:${source}`, deps.accessLimit);
      if (retryAfter !== undefined) return deps.rateLimitResponse(retryAfter);
      const { guestAiName, guestModel } = deps.readConfig();
      const modelDefault = await deps.readDefaultModel();
      const result = deps.ensureGuestChat({
        userId,
        aiName: guestAiName,
        aiModel: guestModel || modelDefault.model,
        apiRouter: modelDefault.apiRouter,
        maxContext: modelDefault.maxContext,
      });
      return c.json({ chatId: result.chatId });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
