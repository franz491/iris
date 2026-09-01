import type { Hono } from "hono";
import type { Message } from "../chat/types.js";
import { UnauthorizedError } from "../misc/error.js";
import { parseStrictSingleQuery } from "./api-validation.js";
import { z } from "zod";

const pollingMessagesQuerySchema = z
  .object({ chatId: z.string().min(1).max(256), lastMessageId: z.string().max(256).default("") })
  .strict();
const pollingChatsQuerySchema = z
  .object({
    timestamp: z.preprocess(
      (value) => (value === undefined || value === "" ? 0 : value),
      z.coerce.number().finite().nonnegative(),
    ),
  })
  .strict();
export const parsePollingMessagesQuery = (request: Request): { chatId: string; lastMessageId: string } =>
  parseStrictSingleQuery(request, pollingMessagesQuerySchema, "polling");
export const parsePollingChatsQuery = (request: Request): { timestamp: number } =>
  parseStrictSingleQuery(request, pollingChatsQuerySchema, "polling");

export interface PollingRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseMessagesQuery: (request: Request) => { chatId: string; lastMessageId: string };
  parseChatsQuery: (request: Request) => { timestamp: number };
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  getMessagesSinceId: (chatId: string, authorId: string, lastMessageId: string) => Promise<Message[]>;
  getChatsSinceTimestamp: (userId: string, timestamp: number) => Promise<unknown[]>;
  filterReadable: (chatId: string, userId: string, messages: Message[]) => Promise<Message[]>;
  errorResponse: (error: unknown) => Response;
}

/** Register polling endpoints without coupling route ownership to the API monolith. */
export function registerPollingRoutes(app: Hono, deps: PollingRouteDeps): void {
  app.get("/polling/messages", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const { chatId, lastMessageId } = deps.parseMessagesQuery(c.req.raw);
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      const messages = await deps.getMessagesSinceId(chatId, "", lastMessageId);
      return c.json({ messages: await deps.filterReadable(chatId, userId, messages) });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.get("/polling/chats", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const { timestamp } = deps.parseChatsQuery(c.req.raw);
      const chats = await deps.getChatsSinceTimestamp(userId, timestamp);
      return c.json({ chats });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
