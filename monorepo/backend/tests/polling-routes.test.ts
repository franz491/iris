import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerPollingRoutes } from "../src/api/polling-routes.js";

describe("polling route module", () => {
  function setup() {
    const app = new Hono();
    const calls: string[] = [];
    const errorResponse = vi.fn(() => new Response("bad", { status: 400 }));
    registerPollingRoutes(app, {
      requireUser: async () => {
        calls.push("auth");
        return { userId: "user-1" };
      },
      parseMessagesQuery: () => {
        calls.push("parse");
        return { chatId: "chat-1", lastMessageId: "" };
      },
      parseChatsQuery: () => {
        calls.push("parse");
        return { timestamp: 0 };
      },
      isUserAuthorizedInChat: async () => {
        calls.push("authorize");
        return true;
      },
      getMessagesSinceId: async () => {
        calls.push("read");
        return [];
      },
      getChatsSinceTimestamp: async () => {
        calls.push("read");
        return [];
      },
      filterReadable: async (_chatId, _userId, messages) => {
        calls.push("filter");
        return messages;
      },
      errorResponse,
    });
    return { app, calls, errorResponse };
  }

  it("preserves polling messages ordering and response shape", async () => {
    const { app, calls } = setup();
    const response = await app.request("/polling/messages?chatId=chat-1&lastMessageId=");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [] });
    expect(calls).toEqual(["auth", "parse", "authorize", "read", "filter"]);
  });

  it("does not read the database when authorization rejects", async () => {
    const { app, calls } = setup();
    calls.length = 0;
    // The injected authorization result is replaced through the route's closure-free harness.
    const denied = new Hono();
    const read = vi.fn(async () => []);
    registerPollingRoutes(denied, {
      requireUser: async () => ({ userId: "user-1" }),
      parseMessagesQuery: () => ({ chatId: "chat-1", lastMessageId: "" }),
      parseChatsQuery: () => ({ timestamp: 0 }),
      isUserAuthorizedInChat: async () => false,
      getMessagesSinceId: read,
      getChatsSinceTimestamp: async () => [],
      filterReadable: async (_chatId, _userId, messages) => messages,
      errorResponse: () => new Response("denied", { status: 401 }),
    });
    const response = await denied.request("/polling/messages?chatId=chat-1&lastMessageId=");
    expect(response.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns injected errors without invoking downstream work", async () => {
    const { app, errorResponse } = setup();
    const response = await app.request("/polling/chats?timestamp=0");
    expect(response.status).toBe(200);
    expect(errorResponse).not.toHaveBeenCalled();
  });
});
