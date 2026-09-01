import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerToolRoutes } from "../src/api/tool-routes.js";

const group = {
  name: "fe_demo",
  flavor: "frontend" as const,
  functions: [{ name: "run", description: "run it", parameters: { type: "object" } }],
};

function setup(overrides: Partial<Parameters<typeof registerToolRoutes>[1]> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  const errorResponse = vi.fn(
    (error: unknown) => new Response(error instanceof Error ? error.message : "error", { status: 400 }),
  );
  registerToolRoutes(app, {
    resolveViewer: async () => {
      calls.push("auth");
      return { userId: "user-1" };
    },
    parseToolsQuery: () => {
      calls.push("parse");
      return { chatId: "" };
    },
    isUserAuthorizedInChat: async () => {
      calls.push("authorize");
      return true;
    },
    getChat: async () => {
      calls.push("chat");
      return { loadedGroups: () => ["fe_demo"] };
    },
    loadCatalog: async () => {
      calls.push("catalog");
      return {
        groups: { fe_demo: group },
        alwaysLoadedGroups: ["fe_demo"],
        loadToolDocs: () => ({ tool: "", functions: {} }),
        aiGroupName: (value) => value.name.replace(/^fe_/, ""),
      };
    },
    errorResponse,
    ...overrides,
  });
  return { app, calls, errorResponse };
}

describe("tool catalog route module", () => {
  it("preserves catalog shape and loads chat state only for scoped requests", async () => {
    const { app, calls } = setup();
    expect(await (await app.request("/tools")).json()).toEqual({
      groups: [
        {
          name: "fe_demo",
          aiName: "demo",
          backend: false,
          flavor: "frontend",
          alwaysLoaded: true,
          editable: true,
          toolDoc: "run it",
          functions: { run: { doc: "run it", parameters: { type: "object" } } },
        },
      ],
    });
    expect(calls).toEqual(["auth", "parse", "catalog"]);
    calls.length = 0;
    const scoped = setup({ parseToolsQuery: () => ({ chatId: "chat-1" }) });
    expect(await (await scoped.app.request("/tools?chatId=chat-1")).json()).toMatchObject({ loaded: ["fe_demo"] });
    expect(scoped.calls).toEqual(["auth", "catalog", "authorize", "chat"]);
  });

  it("fails closed before chat loading when authorization rejects", async () => {
    const getChat = vi.fn();
    const { app, errorResponse } = setup({
      parseToolsQuery: () => ({ chatId: "chat-1" }),
      isUserAuthorizedInChat: async () => false,
      getChat,
    });
    expect((await app.request("/tools?chatId=chat-1")).status).toBe(400);
    expect(errorResponse).toHaveBeenCalledOnce();
    expect(getChat).not.toHaveBeenCalled();
  });
});
