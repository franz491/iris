import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerStreamRoutes, type StreamRouteDeps } from "../src/api/stream-routes.js";
import { PushQueue } from "../src/api/stream-response.js";
import { metricsSnapshot, resetMetrics } from "../src/misc/metrics.js";

function setup(overrides: Partial<StreamRouteDeps> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  const queue = new PushQueue<unknown>();
  const unsub = vi.fn(() => calls.push("unsubscribe"));
  const unregister = vi.fn(() => calls.push("unregister"));
  const deps: StreamRouteDeps = {
    requireUser: async () => {
      calls.push("auth");
      return { userId: "user-1" };
    },
    parseChatId: (value) => {
      calls.push("chat-id");
      return value;
    },
    parseStreamQuery: () => {
      calls.push("query");
      return { clientId: "client-1" };
    },
    isUserAuthorizedInChat: async () => {
      calls.push("authorize");
      return true;
    },
    getChat: async () => {
      calls.push("chat");
      return {
        subscribe: () => {
          calls.push("subscribe");
          return unsub;
        },
        removeToolConfig: () => calls.push("remove-config"),
      };
    },
    readableChatEvent: async () => {
      calls.push("filter");
      return () => true;
    },
    createQueue: () => queue,
    registerSse: (close) => {
      calls.push("register");
      close();
      return unregister;
    },
    errorResponse: vi.fn(() => new Response("error", { status: 400 })),
    ...overrides,
  };
  registerStreamRoutes(app, deps);
  return { app, calls, deps, queue, unsub, unregister, errorResponse: deps.errorResponse };
}

describe("stream route module", () => {
  it("preserves authorization and subscription ordering and connected acknowledgement", async () => {
    const { app, calls } = setup();
    const response = await app.request("/chats/chat-1/stream?clientId=client-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("event: connected");
    expect(calls).toEqual([
      "auth",
      "chat-id",
      "query",
      "authorize",
      "chat",
      "filter",
      "subscribe",
      "register",
      "unsubscribe",
      "remove-config",
      "unregister",
    ]);
  });

  it("rejects unauthorized chats before chat lookup", async () => {
    const getChat = vi.fn();
    const { app, calls, errorResponse } = setup({
      isUserAuthorizedInChat: async () => {
        calls.push("authorize");
        return false;
      },
      getChat,
    });
    expect((await app.request("/chats/private/stream")).status).toBe(400);
    expect(errorResponse).toHaveBeenCalledOnce();
    expect(getChat).not.toHaveBeenCalled();
    expect(calls).toEqual(["auth", "chat-id", "query", "authorize"]);
  });

  it("rejects authentication before parsing or downstream work", async () => {
    const parse = vi.fn(() => ({ clientId: "client-1" }));
    const getChat = vi.fn();
    const { app, calls, errorResponse } = setup({
      requireUser: async () => {
        calls.push("auth");
        throw new Error("denied");
      },
      parseStreamQuery: parse,
      getChat,
    });
    expect((await app.request("/chats/chat-1/stream")).status).toBe(400);
    expect(errorResponse).toHaveBeenCalledOnce();
    expect(parse).not.toHaveBeenCalled();
    expect(getChat).not.toHaveBeenCalled();
  });
});

describe("PushQueue bounds", () => {
  it("records one redacted bounded diagnostic for overflow", () => {
    resetMetrics();
    const queue = new PushQueue<number>(1);
    queue.push(1);
    expect(queue.push(2)).toBe(false);
    expect(queue.push(3)).toBe(false);
    expect(metricsSnapshot().requests).toMatchObject({ "sse.queue_overflows": 1 });
    resetMetrics();
  });

  it("closes and rejects pushes when a slow consumer fills the buffer", () => {
    const queue = new PushQueue<number>(2);
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.push(3)).toBe(false);
    expect(queue.closed).toBe(true);
    expect(queue.didOverflow).toBe(true);
    expect(queue.push(4)).toBe(false);
  });

  it("delivers directly to a waiting consumer without consuming buffer capacity", async () => {
    const queue = new PushQueue<number>(1);
    const next = queue[Symbol.asyncIterator]().next();
    expect(queue.push(7)).toBe(true);
    await expect(next).resolves.toEqual({ done: false, value: 7 });
  });
});
