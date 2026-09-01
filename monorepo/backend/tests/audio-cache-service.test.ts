import { describe, expect, it, vi } from "vitest";
import { createAudioCachePlaybackService } from "../src/api/audio-cache-service.js";

const metadata = { text: "hello", language: "en", voice: "v", style: "s", chatId: "chat" };
const limits = { maxAgeSeconds: 60, maxBytes: 1024 };

describe("audio cache playback service", () => {
  it("maps provider fields, decodes, restores, and deduplicates same-ID work", async () => {
    let resolve!: (value: unknown) => void;
    const generate = vi.fn(() => new Promise<unknown>((r) => (resolve = r)));
    const restore = vi.fn(() => true);
    const service = createAudioCachePlaybackService({
      generate,
      restore,
      parse: (value) => (value as { audio: { base64: string; mimeType?: string } }).audio,
    });
    const first = service("id", metadata, limits);
    const second = service("id", metadata, limits);
    expect(second).toBe(first);
    expect(generate).toHaveBeenCalledTimes(1);
    resolve({ audio: { base64: "AQI=", mimeType: "audio/ogg" } });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(restore).toHaveBeenCalledWith("id", expect.any(Uint8Array), limits, "audio/ogg");
  });

  it("returns false on provider, parser, restore, or malformed-output failure and retries", async () => {
    const generate = vi.fn(async () => ({ bad: true }));
    const service = createAudioCachePlaybackService({ generate, parse: () => null });
    await expect(service("id", metadata, limits)).resolves.toBe(false);
    await expect(service("id", metadata, limits)).resolves.toBe(false);
    expect(generate).toHaveBeenCalledTimes(2);

    const failing = createAudioCachePlaybackService({
      generate: async () => ({ ok: true }),
      parse: () => ({ base64: "AQI=" }),
      restore: () => {
        throw new Error("restore");
      },
    });
    await expect(failing("id", metadata, limits)).resolves.toBe(false);
  });
});
