import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-audio-replay-"));
  vi.resetModules();
});
describe("audio replay provider boundary", () =>
  it("accepts only an object containing non-empty audio base64", async () => {
    const { parseAudioReplayResult } = await import("../src/api/api.js");
    expect(parseAudioReplayResult({ _irisAudio: { base64: "UklGRg==", mimeType: "audio/wav" } })).toEqual({
      base64: "UklGRg==",
      mimeType: "audio/wav",
    });
    expect(parseAudioReplayResult({ _irisAudio: { base64: "" } })).toBeNull();
    expect(parseAudioReplayResult({ _irisAudio: { base64: 123 } })).toBeNull();
    expect(parseAudioReplayResult({ audio: { base64: "UklGRg==" } })).toBeNull();
    expect(parseAudioReplayResult(null)).toBeNull();
  }));
describe("authenticated audio replay", () =>
  it("restricts cached entries to their originating chat", async () => {
    const c = await import("../src/admin/audio-cache.js");
    const id = c.cacheAudio(Buffer.from([1]), { text: "hello", chatId: "chat-a" }, { maxAgeSeconds: 0, maxBytes: 10 });
    expect(c.readCachedAudio(id, { maxAgeSeconds: 0, maxBytes: 10 }, "chat-b")).toBeNull();
    expect(c.readCachedAudio(id, { maxAgeSeconds: 0, maxBytes: 10 }, "chat-a")?.metadata.text).toBe("hello");
  }));
