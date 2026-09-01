import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerStopRoutes } from "../src/api/stop-routes.js";

function setup(overrides: Partial<Parameters<typeof registerStopRoutes>[1]> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  const stopped = new Set<string>(["ai-1", "ai-2"]);
  registerStopRoutes(app, {
    requireUser: async () => {
      calls.push("auth");
      return { userId: "user" };
    },
    parseChatId: (value) => {
      calls.push("id");
      return value;
    },
    isUserAuthorizedInChat: async () => {
      calls.push("membership");
      return true;
    },
    getChat: async () => {
      calls.push("chat");
      return {
        replyingParticipants: () => ["ai-1", "ai-2"],
        stopAiParticipant: (id) => {
          calls.push(`stop:${id}`);
          if (!stopped.has(id)) return false;
          stopped.delete(id);
          return true;
        },
      };
    },
    parseStopBody: async (request) => {
      calls.push("body");
      return (await request.json()) as { participantId?: string };
    },
    errorResponse: (error) => new Response(String(error), { status: 500 }),
    ...overrides,
  });
  return { app, calls };
}

describe("stop route boundary", () => {
  it("preserves auth, membership, lookup, body, and targeted stop order", async () => {
    const { app, calls } = setup();
    const response = await app.request("/chats/chat/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ participantId: "ai-1" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: ["ai-1"] });
    expect(calls).toEqual(["auth", "id", "membership", "chat", "body", "stop:ai-1"]);
  });

  it("stops all currently replying participants and is idempotent", async () => {
    const { app } = setup({
      parseStopBody: async () => ({}),
    });
    const first = await app.request("/chats/chat/stop", { method: "POST" });
    const second = await app.request("/chats/chat/stop", { method: "POST" });
    expect(await first.json()).toEqual({ stopped: ["ai-1", "ai-2"] });
    expect(await second.json()).toEqual({ stopped: [] });
  });

  it("rejects unauthorized membership before chat lookup", async () => {
    const getChat = vi.fn();
    const { app, calls } = setup({
      isUserAuthorizedInChat: async () => {
        calls.push("membership");
        return false;
      },
      getChat,
    });
    expect((await app.request("/chats/chat/stop", { method: "POST" })).status).toBe(500);
    expect(getChat).not.toHaveBeenCalled();
    expect(calls).toEqual(["auth", "id", "membership"]);
  });
});
