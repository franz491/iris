import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerGuestChatRoutes } from "../src/api/guest-chat-routes.js";

function setup(overrides: Partial<Parameters<typeof registerGuestChatRoutes>[1]> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  registerGuestChatRoutes(app, {
    requireUser: async () => {
      calls.push("auth");
      return { userId: "u", isGuest: true };
    },
    getSource: () => "source",
    consumeAccess: () => {
      calls.push("limit");
      return undefined;
    },
    accessLimit: 30,
    rateLimitResponse: () => new Response("limited", { status: 429 }),
    readConfig: () => {
      calls.push("config");
      return { guestAiName: "Guest", guestModel: "" };
    },
    readDefaultModel: async () => {
      calls.push("defaults");
      return { model: "default", apiRouter: "router", maxContext: 4096 };
    },
    ensureGuestChat: () => {
      calls.push("ensure");
      return { chatId: "chat", created: true, repaired: false };
    },
    errorResponse: (error) => new Response(String(error), { status: 500 }),
    ...overrides,
  });
  return { app, calls };
}

describe("guest chat route boundary", () => {
  it("keeps auth and limiter ahead of config and database work", async () => {
    const { app, calls } = setup();
    const response = await app.request("/chats/guest");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ chatId: "chat" });
    expect(calls).toEqual(["auth", "limit", "config", "defaults", "ensure"]);
  });

  it("does not resolve config or touch the singleton when rate limited", async () => {
    const ensure = vi.fn(() => ({ chatId: "never", created: true, repaired: false }));
    const { app, calls } = setup({
      consumeAccess: () => {
        calls.push("limit");
        return 9;
      },
      ensureGuestChat: ensure,
    });
    const response = await app.request("/chats/guest");
    expect(response.status).toBe(429);
    expect(ensure).not.toHaveBeenCalled();
    expect(calls).toEqual(["auth", "limit"]);
  });

  it("rejects registered viewers before consuming the guest limiter", async () => {
    const consume = vi.fn(() => undefined);
    const { app } = setup({
      requireUser: async () => ({ userId: "registered", isGuest: false }),
      consumeAccess: consume,
    });
    expect((await app.request("/chats/guest")).status).toBe(500);
    expect(consume).not.toHaveBeenCalled();
  });
});
