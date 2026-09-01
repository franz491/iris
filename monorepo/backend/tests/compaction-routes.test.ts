import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerCompactionRoutes, type CompactionRouteDeps } from "../src/api/compaction-routes.js";

function setup(overrides: Partial<CompactionRouteDeps> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  const ai = { id: "ai-1", role: "ai" };
  const errorResponse = vi.fn(() => new Response("error", { status: 400 }));
  const deps: CompactionRouteDeps = {
    requireUser: async () => {
      calls.push("auth");
      return { userId: "user-1" };
    },
    parseChatId: (value) => {
      calls.push("chat-id");
      return value;
    },
    parseParticipantId: (value) => {
      calls.push("participant-id");
      return value;
    },
    isUserAuthorizedInChat: async () => {
      calls.push("authorize");
      return true;
    },
    getChat: async () => {
      calls.push("chat");
      return { getParticipants: async () => [ai, { id: "human-1", role: "user" }] };
    },
    compactionProgress: async () => {
      calls.push("progress");
      return { ai: 1 };
    },
    compactChat: async () => {
      calls.push("compact");
    },
    errorResponse,
    ...overrides,
  };
  registerCompactionRoutes(app, deps);
  return { app, calls, errorResponse };
}

describe("compaction route module", () => {
  it("preserves progress and compact ordering and response shapes", async () => {
    const { app, calls } = setup();
    expect(await (await app.request("/chats/chat-1/compaction")).json()).toEqual({ progress: { ai: 1 } });
    expect(calls).toEqual(["auth", "chat-id", "authorize", "chat", "progress"]);
    calls.length = 0;
    expect((await app.request("/chats/chat-1/compact/ai-1", { method: "POST" })).status).toBe(200);
    expect(calls).toEqual(["auth", "chat-id", "participant-id", "authorize", "chat", "compact"]);
  });

  it("rejects unauthorized requests before chat lookup", async () => {
    const getChat = vi.fn();
    const { app, calls, errorResponse } = setup({
      isUserAuthorizedInChat: async () => {
        calls.push("authorize");
        return false;
      },
      getChat,
    });
    expect((await app.request("/chats/private/compaction")).status).toBe(400);
    expect(errorResponse).toHaveBeenCalledOnce();
    expect(getChat).not.toHaveBeenCalled();
  });

  it("does not compact a missing or non-AI participant", async () => {
    const compactChat = vi.fn();
    const { app, errorResponse } = setup({
      compactChat,
      getChat: async () => ({ getParticipants: async () => [{ id: "human-1", role: "user" }] }),
    });
    expect((await app.request("/chats/chat-1/compact/human-1", { method: "POST" })).status).toBe(400);
    expect(errorResponse).toHaveBeenCalledOnce();
    expect(compactChat).not.toHaveBeenCalled();
  });
});
