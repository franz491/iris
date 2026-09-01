import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAudioCacheRoutes, type AudioCacheRouteDeps } from "../src/api/audio-cache-routes.js";

function setup(overrides: Partial<AudioCacheRouteDeps> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  const errorResponse = vi.fn(() => new Response("error", { status: 400 }));
  const deps: AudioCacheRouteDeps = {
    requireUser: async () => {
      calls.push("auth");
      return { userId: "user-1" };
    },
    parseChatQuery: () => {
      calls.push("query");
      return "chat-1";
    },
    parseCacheId: (value) => {
      calls.push("id");
      return value;
    },
    isUserAuthorizedInChat: async () => {
      calls.push("authorize");
      return true;
    },
    readCacheConfig: () => {
      calls.push("config");
      return { enabled: true, maxAgeSeconds: 60, maxBytes: 1000 };
    },
    readCachedAudio: () => {
      calls.push("read");
      return { bytes: Buffer.from([1, 2]), mimeType: "audio/wav" };
    },
    getPlaybackMetadata: () => null,
    regeneratePlayback: async () => false,
    errorResponse,
    ...overrides,
  };
  registerAudioCacheRoutes(app, deps);
  return { app, calls, errorResponse };
}

describe("audio cache route module", () => {
  it("preserves private replay response and ordering", async () => {
    const { app, calls } = setup();
    const response = await app.request("/audio-cache/cache-1?chatId=chat-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/wav");
    expect(response.headers.get("cache-control")).toBe("private, max-age=0");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect(calls).toEqual(["auth", "query", "authorize", "id", "config", "read"]);
  });

  it("does not read cache or metadata when authorization rejects", async () => {
    const read = vi.fn();
    const { app, calls, errorResponse } = setup({
      isUserAuthorizedInChat: async () => {
        calls.push("authorize");
        return false;
      },
      readCachedAudio: read,
    });
    expect((await app.request("/audio-cache/cache-1?chatId=chat-1")).status).toBe(400);
    expect(errorResponse).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("regenerates a missing item and returns 502 when regeneration fails", async () => {
    const regenerate = vi.fn(async () => false);
    const { app } = setup({
      readCachedAudio: () => null,
      getPlaybackMetadata: () => ({ text: "speak" }),
      regeneratePlayback: regenerate,
    });
    const response = await app.request("/audio-cache/cache-1?chatId=chat-1");
    expect(response.status).toBe(502);
    expect(regenerate).toHaveBeenCalledOnce();
  });
});
