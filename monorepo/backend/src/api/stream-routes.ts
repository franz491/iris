import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { StreamPacket } from "./stream-response.js";
import { UnauthorizedError } from "../misc/error.js";
import type { Message } from "../chat/types.js";
import { parseStrictSingleQuery } from "./api-validation.js";
import { z } from "zod";

const sseClientQuerySchema = z.object({ clientId: z.string().max(256).default("") }).strict();
export const parseStreamQuery = (request: Request): { clientId: string } =>
  parseStrictSingleQuery(request, sseClientQuerySchema, "stream");

export type ChatEventPacket = StreamPacket & {
  kind?: string;
  chatId?: string;
  message?: Message;
  targetUserId?: string;
  targetClientId?: string;
  recipientParticipantIds?: string[];
};

interface StreamQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(): void;
}

export interface StreamRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseChatId: (value: string) => string;
  parseStreamQuery: (request: Request) => { clientId: string };
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  getChat: (chatId: string) => Promise<{
    subscribe: (listener: (packet: unknown) => void) => () => void;
    removeToolConfig: (userId: string, clientId: string) => void;
  }>;
  readableChatEvent: (
    chatId: string,
    userId: string,
    clientId: string,
  ) => Promise<(packet: ChatEventPacket) => boolean>;
  createQueue: <T>() => StreamQueue<T>;
  registerSse: (close: () => void) => () => void;
  errorResponse: (error: unknown) => Response;
}

/** Register the authenticated, privacy-filtered chat event stream. */
export function registerStreamRoutes(app: Hono, deps: StreamRouteDeps): void {
  app.get("/chats/:chatId/stream", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatId(c.req.param("chatId"));
      const { clientId } = deps.parseStreamQuery(c.req.raw);
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) {
        throw new UnauthorizedError("not in this chat");
      }
      const chat = await deps.getChat(chatId);
      const canReceive = await deps.readableChatEvent(chatId, userId, clientId);
      const queue = deps.createQueue<StreamPacket>();
      const unsub = chat.subscribe((packet) => {
        const event = packet as ChatEventPacket;
        if (canReceive(event)) queue.push(packet as StreamPacket);
      });
      let unregisterSse: (() => void) | undefined;
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        queue.close();
        unsub();
        if (clientId) chat.removeToolConfig(userId, clientId);
        unregisterSse?.();
      };
      unregisterSse = deps.registerSse(cleanup);
      // A test or adapter may invoke the close callback synchronously while
      // registering.  Unregister after the handle exists to avoid a leaked
      // registry entry while retaining idempotent cleanup.
      if (cleaned) unregisterSse();
      const onAbort = () => cleanup();
      c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
      return streamSSE(c, async (stream) => {
        try {
          await stream.writeSSE({ event: "connected", data: "{}" });
          for await (const packet of queue) {
            const name = String((packet as ChatEventPacket).kind ?? packet.event ?? "message");
            await stream.writeSSE({ event: name, data: JSON.stringify(packet) });
          }
        } finally {
          c.req.raw.signal.removeEventListener("abort", onAbort);
          cleanup();
        }
      });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
