import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerChatReadRoutes } from "../src/api/chat-read-routes.js";

function setup() {
  const app = new Hono();
  const calls: string[] = [];
  const errorResponse = vi.fn(() => new Response("error", { status: 400 }));
  registerChatReadRoutes(app, {
    requireUser: async () => {
      calls.push("auth");
      return { userId: "user-1" };
    },
    parseChatId: (value) => {
      calls.push("id");
      return value;
    },
    parseHistoryQuery: () => {
      calls.push("query");
      return { before: 10, limit: 2 };
    },
    isUserAuthorizedInChat: async () => {
      calls.push("authorize");
      return true;
    },
    getHistoryPage: async () => {
      calls.push("history");
      return { messages: [], hasMore: false, oldestSeq: null };
    },
    filterReadable: async (_chatId, _userId, messages) => {
      calls.push("filter");
      return messages;
    },
    getChat: async () => {
      calls.push("chat");
      return { getParticipants: async () => [{ id: "participant-1" }] };
    },
    errorResponse,
  });
  return { app, calls, errorResponse };
}

describe("chat read route module", () => {
  it("preserves history response and dependency ordering", async () => {
    const { app, calls } = setup();
    const response = await app.request("/chats/chat-1/history?before=10&limit=2");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ messages: [], hasMore: false, oldestSeq: null });
    expect(calls).toEqual(["auth", "id", "authorize", "query", "history", "filter"]);
  });

  it("preserves participant serialization after authorization", async () => {
    const { app, calls } = setup();
    const response = await app.request("/chats/chat-1/participants");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ participants: [{ id: "participant-1" }] });
    expect(calls).toEqual(["auth", "id", "authorize", "chat"]);
  });

  it("does not read history or construct a chat when membership rejects", async () => {
    const app = new Hono();
    const read = vi.fn(async () => ({ messages: [], hasMore: false, oldestSeq: null }));
    const getChat = vi.fn(async () => ({ getParticipants: async () => [] }));
    registerChatReadRoutes(app, {
      requireUser: async () => ({ userId: "user-1" }),
      parseChatId: (value) => value,
      parseHistoryQuery: () => ({ limit: 2 }),
      isUserAuthorizedInChat: async () => false,
      getHistoryPage: read,
      filterReadable: async (_chatId, _userId, messages) => messages,
      getChat,
      errorResponse: () => new Response("denied", { status: 401 }),
    });
    expect((await app.request("/chats/chat-1/history")).status).toBe(401);
    expect((await app.request("/chats/chat-1/participants")).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect(getChat).not.toHaveBeenCalled();
  });
});
