import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerMessageRoutes } from "../src/api/message-routes.js";
import type { Participant } from "../src/chat/types.js";

const participants = [
  { id: "user", role: "user", name: "Alice", userId: "alice" },
  { id: "ai", role: "ai", name: "Bot", model: "m", apiRouter: "r" },
] as Participant[];

function setup(overrides: Partial<Parameters<typeof registerMessageRoutes>[1]> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  const sendMessage = vi.fn(async (message) => ({ ...message, id: "message" }));
  registerMessageRoutes(app, {
    requireUser: async () => {
      calls.push("auth");
      return { userId: "alice" };
    },
    getSource: () => "source",
    consumeGuest: () => undefined,
    guestMessageLimit: 20,
    rateLimitResponse: () => new Response("guest limited", { status: 429 }),
    parseChatId: (value) => {
      calls.push("id");
      return value;
    },
    isUserAuthorizedInChat: async () => {
      calls.push("membership");
      return true;
    },
    parseBody: async () => {
      calls.push("body");
      return { content: "hello" };
    },
    getChat: async () => ({
      getParticipants: async () => {
        calls.push("participants");
        return participants;
      },
      sendMessage,
    }),
    scheduleGuestHygiene: () => calls.push("hygiene"),
    tryAcquire: () => [{ release: () => undefined }],
    modelRateLimitResponse: () => new Response("model limited", { status: 429 }),
    errorResponse: (error) => new Response(String(error), { status: 500 }),
    ...overrides,
  });
  return { app, calls, sendMessage };
}

describe("message route boundary", () => {
  it("preserves lifecycle ordering and sends the resolved message", async () => {
    const { app, calls, sendMessage } = setup();
    const response = await app.request("/chats/chat/messages", { method: "POST" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ messageId: "message" });
    expect(calls).toEqual(["auth", "id", "membership", "body", "hygiene", "participants", "membership"]);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat", authorId: "user", content: "hello", type: "text", to: undefined }),
      false,
      expect.any(Array),
    );
  });

  it("rejects model admission before sending", async () => {
    const sendMessage = vi.fn();
    const { app } = setup({
      getChat: async () => ({ getParticipants: async () => participants, sendMessage }),
      tryAcquire: () => undefined,
    });
    expect((await app.request("/chats/chat/messages", { method: "POST" })).status).toBe(429);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects the guest limiter before ID, body, or chat work", async () => {
    const getChat = vi.fn();
    const { app, calls } = setup({
      requireUser: async () => {
        calls.push("auth");
        return { userId: "guest" };
      },
      consumeGuest: () => {
        calls.push("guest-limit");
        return 1;
      },
      getChat,
    });
    expect((await app.request("/chats/chat/messages", { method: "POST" })).status).toBe(429);
    expect(getChat).not.toHaveBeenCalled();
    expect(calls).toEqual(["auth", "guest-limit"]);
  });
});
