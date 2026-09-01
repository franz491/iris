import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerChatLifecycleRoutes } from "../src/api/chat-lifecycle-routes.js";
import { AppError } from "../src/misc/error.js";

function setup(overrides: Partial<Parameters<typeof registerChatLifecycleRoutes>[1]> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  const errorResponse = (error: unknown) => new Response(String(error), { status: 400 });
  const deleteChat = vi.fn(async () => undefined);
  const evictChat = vi.fn();
  const emitDeleted = vi.fn();
  registerChatLifecycleRoutes(app, {
    requireUser: async () => {
      calls.push("auth");
      return { userId: "user-1" };
    },
    parseChatId: (value) => {
      calls.push("id");
      return value;
    },
    isUserAuthorizedInChat: async () => {
      calls.push("authorize");
      return true;
    },
    parseRenameBody: async () => {
      calls.push("rename-body");
      return { name: "renamed" };
    },
    getAppMeta: async () => {
      calls.push("meta");
      return null;
    },
    clearContext: async () => calls.push("clear"),
    renameChat: async () => calls.push("rename"),
    getChat: async () => {
      calls.push("chat");
      return { emitDeleted };
    },
    deleteChat,
    evictChat,
    errorResponse,
    ...overrides,
  });
  return { app, calls, deleteChat, evictChat, emitDeleted };
}

describe("chat lifecycle route module", () => {
  it("clears context after authorization", async () => {
    const { app, calls } = setup();
    const response = await app.request("/chats/chat-1/context", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toEqual(["auth", "id", "authorize", "clear"]);
  });

  it("checks guest metadata before parsing or renaming", async () => {
    const { app, calls } = setup();
    const response = await app.request("/chats/chat-1", {
      method: "PATCH",
      body: JSON.stringify({ name: "renamed" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["auth", "id", "authorize", "meta", "rename-body", "rename"]);
  });

  it("notifies live subscribers before deleting and evicts afterward", async () => {
    const { app, calls, deleteChat, evictChat, emitDeleted } = setup();
    const response = await app.request("/chats/chat-1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(calls).toEqual(["auth", "id", "authorize", "meta", "chat"]);
    expect(emitDeleted).toHaveBeenCalledOnce();
    expect(deleteChat).toHaveBeenCalledWith("chat-1");
    expect(evictChat).toHaveBeenCalledWith("chat-1");
  });

  it("rejects guest rename/delete with client errors before body or live work", async () => {
    const errors: unknown[] = [];
    const { app, calls } = setup({
      getAppMeta: async () => "chat-1",
      errorResponse: (error) => {
        errors.push(error);
        return new Response(null, {
          status: error instanceof AppError && error.code === "validation_error" ? 400 : 500,
        });
      },
    });
    expect((await app.request("/chats/chat-1", { method: "PATCH", body: "not-json" })).status).toBe(400);
    expect(calls).toEqual(["auth", "id", "authorize"]);
    expect(errors[0]).toBeInstanceOf(AppError);
    expect((errors[0] as AppError).code).toBe("validation_error");
  });
});
