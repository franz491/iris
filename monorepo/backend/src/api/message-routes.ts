import type { Hono } from "hono";
import { GUEST_USER_ID } from "../chat/auth.js";
import type { Message, Participant } from "../chat/types.js";
import type { ModelAdmissionLease } from "./model-admission.js";
import { UnauthorizedError } from "../misc/error.js";
import { reserveMessageAdmission } from "./message-admission.js";
import { resolveMessageRecipients } from "./message-recipient-resolver.js";
import { z } from "zod";

export const createMessageSchema = z.object({
  content: z.string().min(1, "content is required").max(1_000_000, "content is too long"),
  thought: z.string().max(1_000_000, "thought is too long").optional(),
  type: z.enum(["text", "file"]).optional(),
  to: z.array(z.string().min(1).max(256)).max(256).optional(),
});

export interface MessageRouteBody {
  content: string;
  thought?: string;
  type?: "text" | "file";
  to?: string[];
}

export interface MessageRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  getSource: (request: Request) => string | undefined;
  consumeGuest: (key: string, limit: number) => number | undefined;
  guestMessageLimit: number;
  rateLimitResponse: (retryAfter: number) => Response;
  parseChatId: (value: string) => string;
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  parseBody: (request: Request) => Promise<MessageRouteBody>;
  getChat: (chatId: string) => Promise<{
    getParticipants(): Promise<Participant[]>;
    sendMessage(
      message: Omit<Message, "id" | "createdAt" | "seq">,
      silent: boolean,
      admission: ModelAdmissionLease[],
    ): Promise<Message>;
  }>;
  scheduleGuestHygiene: (chatId: string) => void;
  tryAcquire: (keys: readonly string[], slots: number) => ModelAdmissionLease[] | undefined;
  modelRateLimitResponse: () => Response;
  errorResponse: (error: unknown) => Response;
}

/** Register chat message submission while leaving generation ownership in ChatInstance. */
export function registerMessageRoutes(app: Hono, deps: MessageRouteDeps): void {
  app.post("/chats/:chatId/messages", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      if (userId === GUEST_USER_ID) {
        const source = deps.getSource(c.req.raw) ?? "unknown";
        const retryAfter = deps.consumeGuest(`message:source:${source}`, deps.guestMessageLimit);
        if (retryAfter !== undefined) return deps.rateLimitResponse(retryAfter);
      }
      const chatId = deps.parseChatId(c.req.param("chatId"));
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      const body = await deps.parseBody(c.req.raw);
      const chat = await deps.getChat(chatId);
      deps.scheduleGuestHygiene(chatId);
      const participants = await chat.getParticipants();
      const { author, to, targets } = resolveMessageRecipients({
        content: body.content,
        explicitRecipients: body.to,
        participants,
        userId,
      });
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      const source = deps.getSource(c.req.raw);
      const admission = reserveMessageAdmission({
        userId,
        source,
        targetCount: targets.length,
        tryAcquire: deps.tryAcquire,
      });
      if (targets.length && !admission) return deps.modelRateLimitResponse();
      const message = await chat.sendMessage(
        {
          chatId,
          authorId: author.id,
          type: body.type === "file" ? "file" : "text",
          thought: body.thought ?? "",
          content: body.content,
          to,
        },
        false,
        admission ?? [],
      );
      return c.json({ messageId: message.id }, 201);
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
