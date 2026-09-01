import type { Hono } from "hono";
import { UnauthorizedError, ValidationError } from "../misc/error.js";
import { z } from "zod";

export const renameChatSchema = z.object({ name: z.string().trim().min(1).max(256) }).strict();

export interface ChatLifecycleRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseChatId: (value: string) => string;
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  parseRenameBody: (request: Request) => Promise<{ name: string }>;
  getAppMeta: (key: string) => Promise<string | null>;
  clearContext: (chatId: string) => Promise<void>;
  renameChat: (chatId: string, name: string) => Promise<void>;
  getChat: (chatId: string) => Promise<{ emitDeleted: () => void }>;
  deleteChat: (chatId: string) => Promise<void>;
  evictChat: (chatId: string) => void;
  errorResponse: (error: unknown) => Response;
}

/** Register chat context, naming, and deletion lifecycle mutations. */
export function registerChatLifecycleRoutes(app: Hono, deps: ChatLifecycleRouteDeps): void {
  app.delete("/chats/:chatId/context", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      await deps.clearContext(chatId);
      return c.json({ ok: true });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.patch("/chats/:chatId", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      if ((await deps.getAppMeta("guest_chat_id")) === chatId) {
        return deps.errorResponse(new ValidationError("the guest chat cannot be renamed"));
      }
      const body = await deps.parseRenameBody(c.req.raw);
      await deps.renameChat(chatId, body.name);
      return c.json({ ok: true });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.delete("/chats/:chatId", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      if ((await deps.getAppMeta("guest_chat_id")) === chatId) {
        return deps.errorResponse(new ValidationError("the guest chat cannot be deleted; use 'delete context'"));
      }
      try {
        const chat = await deps.getChat(chatId);
        chat.emitDeleted();
      } catch {
        // Deletion does not depend on a live ChatInstance.
      }
      await deps.deleteChat(chatId);
      deps.evictChat(chatId);
      return c.json({ ok: true });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
