import type { Hono } from "hono";
import type { Message } from "../chat/types.js";
import { UnauthorizedError } from "../misc/error.js";
import { z } from "zod";

export const rewriteMessageSchema = z
  .object({
    content: z.string().min(1).max(1_000_000).optional(),
    thought: z.string().max(1_000_000).optional(),
  })
  .strict();

export interface MessageRewritePatch {
  content?: string;
  thought?: string;
}

export interface MessageRewriteResult {
  message: Message;
  deletedFollowing: number;
  regenerating: boolean;
}

interface TruncatedMessageEvent {
  kind: "truncated";
  chatId: string;
  fromMessageId: string;
  count: number;
  recipientParticipantIds: string[];
}

export interface MessageMutationRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseChatId: (value: string) => string;
  parseMessageId: (value: string) => string;
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  parseRewriteBody: (request: Request) => Promise<MessageRewritePatch>;
  getChat: (chatId: string) => Promise<{
    rewriteHistory: (messageId: string, patch: MessageRewritePatch) => Promise<MessageRewriteResult>;
    invalidateHistory: () => void;
    emit: (packet: TruncatedMessageEvent) => void;
  }>;
  deleteMessageAndFollowing: (chatId: string, messageId: string) => Promise<number>;
  errorResponse: (error: unknown) => Response;
}

/** Register message rewrite and branch-deletion mutations. */
export function registerMessageMutationRoutes(app: Hono, deps: MessageMutationRouteDeps): void {
  app.patch("/chats/:chatId/messages/:messageId", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      const messageId = deps.parseMessageId(c.req.param("messageId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) {
        throw new UnauthorizedError("not in this chat");
      }
      const body = await deps.parseRewriteBody(c.req.raw);
      const chat = await deps.getChat(chatId);
      return c.json(await chat.rewriteHistory(messageId, body));
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.delete("/chats/:chatId/messages/:messageId", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      const messageId = deps.parseMessageId(c.req.param("messageId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) {
        throw new UnauthorizedError("not in this chat");
      }
      const chat = await deps.getChat(chatId);
      // Deleting a branch invalidates any in-flight generation built from it;
      // otherwise a stale completion could be persisted after the deletion.
      chat.invalidateHistory();
      const deleted = await deps.deleteMessageAndFollowing(chatId, messageId);
      try {
        chat.emit({
          kind: "truncated",
          chatId,
          fromMessageId: messageId,
          count: deleted,
          recipientParticipantIds: [],
        });
      } catch {
        // A deleted branch does not depend on a live ChatInstance.
      }
      return c.json({ deleted });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
