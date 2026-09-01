import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerMessageMutationRoutes } from "../src/api/message-mutation-routes.js";

function setup() {
  const app = new Hono();
  const calls: string[] = [];
  const rewriteHistory = vi.fn(async () => ({
    message: { id: "message-1" },
    deletedFollowing: 2,
    regenerating: false,
  }));
  const emit = vi.fn();
  const invalidateHistory = vi.fn(() => calls.push("invalidate"));
  registerMessageMutationRoutes(app, {
    requireUser: async () => {
      calls.push("auth");
      return { userId: "user-1" };
    },
    parseChatId: (value) => {
      calls.push("chat-id");
      return value;
    },
    parseMessageId: (value) => {
      calls.push("message-id");
      return value;
    },
    isUserAuthorizedInChat: async () => {
      calls.push("authorize");
      return true;
    },
    parseRewriteBody: async () => {
      calls.push("body");
      return { content: "rewritten" };
    },
    getChat: async () => {
      calls.push("chat");
      return { rewriteHistory, invalidateHistory, emit };
    },
    deleteMessageAndFollowing: async () => {
      calls.push("delete");
      return 3;
    },
    errorResponse: () => new Response("error", { status: 400 }),
  });
  return { app, calls, rewriteHistory, emit };
}

describe("message mutation route module", () => {
  it("preserves rewrite ordering and delegates the result", async () => {
    const { app, calls, rewriteHistory } = setup();
    const response = await app.request("/chats/chat-1/messages/message-1", {
      method: "PATCH",
      body: JSON.stringify({ content: "rewritten" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: { id: "message-1" }, deletedFollowing: 2, regenerating: false });
    expect(calls).toEqual(["auth", "chat-id", "message-id", "authorize", "body", "chat"]);
    expect(rewriteHistory).toHaveBeenCalledWith("message-1", { content: "rewritten" });
  });

  it("deletes first, then best-effort emits the truncated event", async () => {
    const { app, calls, emit } = setup();
    const response = await app.request("/chats/chat-1/messages/message-1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 3 });
    expect(calls).toEqual(["auth", "chat-id", "message-id", "authorize", "chat", "invalidate", "delete"]);
    expect(emit).toHaveBeenCalledWith({
      kind: "truncated",
      chatId: "chat-1",
      fromMessageId: "message-1",
      count: 3,
      recipientParticipantIds: [],
    });
  });

  it("does not mutate or construct a chat after membership rejection", async () => {
    const app = new Hono();
    const rewriteHistory = vi.fn();
    const getChat = vi.fn();
    registerMessageMutationRoutes(app, {
      requireUser: async () => ({ userId: "user-1" }),
      parseChatId: (value) => value,
      parseMessageId: (value) => value,
      isUserAuthorizedInChat: async () => false,
      parseRewriteBody: async () => ({ content: "nope" }),
      getChat: getChat as never,
      deleteMessageAndFollowing: rewriteHistory as never,
      errorResponse: () => new Response("denied", { status: 401 }),
    });
    expect((await app.request("/chats/chat-1/messages/message-1", { method: "PATCH" })).status).toBe(401);
    expect((await app.request("/chats/chat-1/messages/message-1", { method: "DELETE" })).status).toBe(401);
    expect(getChat).not.toHaveBeenCalled();
    expect(rewriteHistory).not.toHaveBeenCalled();
  });
});
