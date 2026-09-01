import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerToolControlRoutes, type ToolControlRouteDeps } from "../src/api/tool-control-routes.js";

function setup(overrides: Partial<ToolControlRouteDeps> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  const errorResponse = vi.fn(() => new Response("error", { status: 400 }));
  const chat = {
    setToolConfig: vi.fn(() => calls.push("set-config")),
    setLoadedGroups: vi.fn(async () => calls.push("set-loaded")),
    effectiveToolConfig: () => ({ tools: [{ tool: "memory" }] }),
    loadedGroups: () => ["memory"],
    resolveToolRequest: vi.fn(() => {
      calls.push("resolve");
      return true;
    }),
  };
  const deps: ToolControlRouteDeps = {
    parseChatId: (value) => {
      calls.push("chat-id");
      return value;
    },
    requireChatMember: async () => {
      calls.push("auth");
      return { userId: "user-1" };
    },
    parseToolConfig: () => {
      calls.push("parse-config");
      return { clientId: "client-1", tools: [{ tool: "memory" }] };
    },
    parseToolResponse: () => {
      calls.push("parse-response");
      return { requestId: "request-1", clientId: "client-1", approved: true, result: { ok: true } };
    },
    getChat: async () => {
      calls.push("chat");
      return chat;
    },
    errorResponse,
    ...overrides,
  };
  registerToolControlRoutes(app, deps);
  return { app, calls, chat, errorResponse };
}

describe("tool control route module", () => {
  it("preserves config validation, chat ordering, and response shape", async () => {
    const { app, calls } = setup();
    expect(await (await app.request("/chats/chat-1/tool-config", { method: "PATCH", body: "{}" })).json()).toEqual({
      ok: true,
      active: 1,
      loaded: ["memory"],
    });
    expect(calls).toEqual(["chat-id", "auth", "parse-config", "chat", "set-config"]);
  });

  it("resolves a pending tool response only after auth, parsing, and lookup", async () => {
    const { app, calls, chat } = setup();
    expect(await (await app.request("/chats/chat-1/tool-response", { method: "POST", body: "{}" })).json()).toEqual({
      ok: true,
    });
    expect(calls).toEqual(["chat-id", "auth", "parse-response", "chat", "resolve"]);
    expect(chat.resolveToolRequest).toHaveBeenCalledWith(
      "request-1",
      { userId: "user-1", clientId: "client-1" },
      { approved: true, result: { ok: true }, error: undefined },
    );
  });

  it("does not look up chat when auth or body validation rejects", async () => {
    const getChat = vi.fn();
    const { app, calls, errorResponse } = setup({
      requireChatMember: async () => {
        calls.push("auth");
        throw new Error("denied");
      },
      getChat,
    });
    expect((await app.request("/chats/chat-1/tool-config", { method: "PATCH", body: "{}" })).status).toBe(400);
    expect(errorResponse).toHaveBeenCalledOnce();
    expect(getChat).not.toHaveBeenCalled();
  });

  it("converts an expired response to the existing error path", async () => {
    const { app, errorResponse } = setup({
      getChat: async () => ({
        ...setup().chat,
        resolveToolRequest: () => false,
      }),
    });
    expect((await app.request("/chats/chat-1/tool-response", { method: "POST", body: "{}" })).status).toBe(400);
    expect(errorResponse).toHaveBeenCalledOnce();
  });
});
