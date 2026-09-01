import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAudioHandleRoutes } from "../src/api/audio-handle-routes.js";

describe("audio handle route module", () => {
  it("authorizes before reading upload bytes and preserves the created handle response", async () => {
    const app = new Hono();
    const calls: string[] = [];
    const read = vi.fn(async () => {
      calls.push("read");
      return Buffer.from("RIFF");
    });
    registerAudioHandleRoutes(app, {
      requireUser: async () => ({ userId: "user-1" }),
      parseToken: (value) => value,
      parseChatQuery: () => {
        calls.push("parse");
        return "chat-1";
      },
      getTransientAudio: () => null,
      isUserAuthorizedInChat: async () => {
        calls.push("authorize");
        return true;
      },
      readBoundedBody: read,
      maxAudioBytes: () => 100,
      validateWavUpload: () => "audio/wav",
      registerTransientAudio: () => "handle-1",
      errorResponse: () => new Response("bad", { status: 500 }),
    });
    const response = await app.request("/audio-handles?chatId=chat-1", { method: "POST", body: "data" });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ audioHandle: "handle-1" });
    expect(calls).toEqual(["parse", "authorize", "read"]);
  });

  it("does not read an unauthorized upload", async () => {
    const app = new Hono();
    const read = vi.fn(async () => Buffer.from("RIFF"));
    registerAudioHandleRoutes(app, {
      requireUser: async () => ({ userId: "user-1" }),
      parseToken: (value) => value,
      parseChatQuery: () => "chat-1",
      getTransientAudio: () => null,
      isUserAuthorizedInChat: async () => false,
      readBoundedBody: read,
      maxAudioBytes: () => 100,
      validateWavUpload: () => "audio/wav",
      registerTransientAudio: () => "handle-1",
      errorResponse: () => new Response("denied", { status: 401 }),
    });
    const response = await app.request("/audio-handles?chatId=chat-1", { method: "POST", body: "data" });
    expect(response.status).toBe(401);
    expect(read).not.toHaveBeenCalled();
  });

  it("returns transient audio with no-store and rejects missing tokens", async () => {
    const app = new Hono();
    registerAudioHandleRoutes(app, {
      requireUser: async () => ({ userId: "user-1" }),
      parseToken: (value) => value,
      parseChatQuery: () => "chat-1",
      getTransientAudio: (token) =>
        token === "token-1" ? { chatId: "chat-1", bytes: Buffer.from([1, 2]), mimeType: "audio/wav" } : null,
      isUserAuthorizedInChat: async () => true,
      readBoundedBody: async () => Buffer.alloc(0),
      maxAudioBytes: () => 100,
      validateWavUpload: () => "audio/wav",
      registerTransientAudio: () => "handle-1",
      errorResponse: () => new Response("bad", { status: 500 }),
    });
    const audio = await app.request("/audio/token-1");
    expect(audio.status).toBe(200);
    expect(audio.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect((await app.request("/audio/missing")).status).toBe(404);
  });
});
