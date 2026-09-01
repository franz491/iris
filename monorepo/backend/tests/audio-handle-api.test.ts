import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(async () => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-audio-handle-api-"));
  process.env.IRIS_BETTER_AUTH_SECRET = "test-secret-audio-handle-012345";
  vi.resetModules();
  const { migrateChatDb } = await import("../src/chat/database.js");
  migrateChatDb();
});

describe("audio-handle upload limits", () => {
  it("rejects invalid audio and oversized handles with explicit client errors", async () => {
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const { MAX_AUDIO_HANDLE_BYTES } = await import("../src/api/binary-limits.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const { api } = await import("../src/api/api.js");

    const invalid = await api.request(`/audio-handles?chatId=${chat.id}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(44),
    });
    expect(invalid.status).toBe(400);

    const oversized = await api.request(`/audio-handles?chatId=${chat.id}`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: new Uint8Array(MAX_AUDIO_HANDLE_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
  });

  it("rejects unknown and oversized query values before reading audio", async () => {
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const { api } = await import("../src/api/api.js");
    const init = { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1, 2, 3]) } as const;
    expect((await api.request(`/audio-handles?chatId=${chat.id}&unexpected=x`, init)).status).toBe(400);
    expect((await api.request(`/audio-handles?chatId=${"x".repeat(257)}`, init)).status).toBe(400);
    expect((await api.request(`/audio-cache/cache-id?chatId=${chat.id}&unexpected=x`)).status).toBe(400);
    expect((await api.request(`/audio-cache/cache-id?chatId=${"x".repeat(257)}`)).status).toBe(400);
  });

  it("rejects empty, duplicate, and decoded oversized chat IDs", async () => {
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const { api } = await import("../src/api/api.js");
    const init = { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array([1, 2, 3]) } as const;

    expect((await api.request(`/audio-handles?chatId=`, init)).status).toBe(400);
    const duplicate = await api.request(`/audio-handles?chatId=${chat.id}&chatId=${chat.id}`, init);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    const encodedOversized = encodeURIComponent("x".repeat(257));
    expect((await api.request(`/audio-handles?chatId=${encodedOversized}`, init)).status).toBe(400);
  });
});
