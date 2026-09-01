import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerParticipantRoutes } from "../src/api/participant-routes.js";
import { AppError } from "../src/misc/error.js";

function setup(overrides: Partial<Parameters<typeof registerParticipantRoutes>[1]> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  const evictChat = vi.fn();
  const updateAiParticipant = vi.fn(async () => undefined);
  registerParticipantRoutes(app, {
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
    parseAddBody: async () => {
      calls.push("add-body");
      return { role: "ai", name: "bot" };
    },
    parsePatchBody: async () => {
      calls.push("patch-body");
      return { readsOthersThoughts: true };
    },
    parseSettingsBody: async () => {
      calls.push("settings-body");
      return { userInterruptions: true };
    },
    findUserByName: () => ({ id: "user-2", name: "alice" }),
    getUserImage: () => undefined,
    addParticipant: async (_chatId, participant) => ({ ...participant, id: "participant-1" }) as never,
    getParticipants: async () => [{ id: "participant-1", role: "ai" }] as never,
    updateAiParticipant,
    getChat: async () => ({
      setSettings: async (patch) => ({ ...patch, aiInterruptions: false, forceAiReply: false }),
    }),
    evictChat,
    errorResponse: () => new Response("error", { status: 400 }),
    ...overrides,
  });
  return { app, calls, evictChat, updateAiParticipant };
}

describe("participant route module", () => {
  it("preserves add ordering and AI response semantics", async () => {
    const { app, calls } = setup();
    const response = await app.request("/chats/chat-1/participants", {
      method: "POST",
      body: JSON.stringify({ role: "ai", name: "bot" }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: "participant-1", role: "ai" });
    expect(calls).toEqual(["auth", "chat-id", "authorize", "add-body"]);
  });

  it("checks the target before patching and evicts the cached chat", async () => {
    const { app, calls, evictChat, updateAiParticipant } = setup();
    const response = await app.request("/chats/chat-1/participants/participant-1", {
      method: "PATCH",
      body: JSON.stringify({ readsOthersThoughts: true }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual(["auth", "chat-id", "participant-id", "authorize", "patch-body"]);
    expect(updateAiParticipant).toHaveBeenCalledWith("participant-1", { readsOthersThoughts: true });
    expect(evictChat).toHaveBeenCalledWith("chat-1");
  });

  it("preserves settings persistence after authorization and parsing", async () => {
    const { app, calls } = setup();
    const response = await app.request("/chats/chat-1/settings", {
      method: "PATCH",
      body: JSON.stringify({ userInterruptions: true }),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userInterruptions: true, aiInterruptions: false, forceAiReply: false });
    expect(calls).toEqual(["auth", "chat-id", "authorize", "settings-body"]);
  });

  it("uses a client-error envelope for missing or unknown human names", async () => {
    const errors: unknown[] = [];
    const { app } = setup({
      parseAddBody: async () => ({ role: "user" }),
      errorResponse: (error) => {
        errors.push(error);
        return new Response(null, {
          status: error instanceof AppError && error.code === "validation_error" ? 400 : 500,
        });
      },
    });
    expect((await app.request("/chats/chat-1/participants", { method: "POST" })).status).toBe(400);
    expect(errors[0]).toBeInstanceOf(AppError);
    expect((errors[0] as AppError).code).toBe("validation_error");

    const unknown = setup({
      parseAddBody: async () => ({ role: "user", name: "missing" }),
      findUserByName: () => undefined,
      errorResponse: (error) => {
        errors.push(error);
        return new Response(null, {
          status: error instanceof AppError && error.code === "validation_error" ? 400 : 500,
        });
      },
    });
    expect((await unknown.app.request("/chats/chat-1/participants", { method: "POST" })).status).toBe(400);
    expect(errors[1]).toBeInstanceOf(AppError);
    expect((errors[1] as AppError).code).toBe("validation_error");
  });
});
