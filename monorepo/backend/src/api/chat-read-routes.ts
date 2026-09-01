import type { Hono } from "hono";
import type { Message } from "../chat/types.js";
import { UnauthorizedError } from "../misc/error.js";
import { parseStrictSingleQuery } from "./api-validation.js";
import { z } from "zod";

const historyQuerySchema = z
  .object({
    before: z.preprocess(
      (value) => (value === undefined || value === "" ? undefined : value),
      z.coerce.number().int().nonnegative().optional(),
    ),
    limit: z.preprocess(
      (value) => (value === undefined || value === "" ? 50 : value),
      z.coerce.number().int().positive().max(200),
    ),
  })
  .strict();
export const parseHistoryQuery = (request: Request): { before?: number; limit: number } =>
  parseStrictSingleQuery(request, historyQuerySchema, "history");

export interface ChatReadRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseChatId: (value: string) => string;
  parseHistoryQuery: (request: Request) => { before?: number; limit: number };
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  getHistoryPage: (
    chatId: string,
    before: number | null,
    limit: number,
  ) => Promise<{ messages: Message[]; hasMore: boolean; oldestSeq: number | null }>;
  filterReadable: (chatId: string, userId: string, messages: Message[]) => Promise<Message[]>;
  getChat: (chatId: string) => Promise<{ getParticipants: () => Promise<unknown> }>;
  errorResponse: (error: unknown) => Response;
}

/** Register read-only chat history and participant catalog endpoints. */
export function registerChatReadRoutes(app: Hono, deps: ChatReadRouteDeps): void {
  app.get("/chats/:chatId/history", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      const query = deps.parseHistoryQuery(c.req.raw);
      const page = await deps.getHistoryPage(chatId, query.before ?? null, query.limit);
      return c.json({ ...page, messages: await deps.filterReadable(chatId, userId, page.messages) });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.get("/chats/:chatId/participants", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      return c.json({ participants: await (await deps.getChat(chatId)).getParticipants() });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
