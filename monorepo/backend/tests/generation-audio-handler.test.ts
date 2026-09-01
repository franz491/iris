import { describe, expect, it, vi } from "vitest";
import { handleGeneratedAudio, parseGeneratedAudioResult } from "../src/chat/generation-audio-handler.js";
import { resetRuntimeLimitsForTests } from "../src/config/runtime-limits.js";

const metadata = { text: "hello", language: "en", voice: "alloy", chatId: "chat-1" };

function deps(cache?: { enabled: boolean; maxAgeSeconds: number; maxBytes: number }) {
  const order: string[] = [];
  const emitAudioReady = vi.fn((token: string) => order.push(`emit:${token}`));
  const registerTransientAudio = vi.fn((_chatId: string, bytes: Buffer, _mime: string) => {
    order.push(`register:${bytes.length}`);
    return "transient-1";
  });
  const cacheAudio = vi.fn((_bytes: Buffer, _metadata: unknown, _limits: unknown, _mime: string) => {
    order.push("cache");
    return "cached-1";
  });
  return {
    order,
    emitAudioReady,
    registerTransientAudio,
    cacheAudio,
    deps: { cache, emitAudioReady, registerTransientAudio, cacheAudio },
  };
}

describe("generation audio handler", () => {
  it("rejects non-canonical base64 and decoded audio over the configured cap", () => {
    expect(parseGeneratedAudioResult({ _irisAudio: { base64: "AQ" } })).toBeNull();
    expect(parseGeneratedAudioResult({ _irisAudio: { base64: "AQ===" } })).toBeNull();
    expect(parseGeneratedAudioResult({ _irisAudio: { base64: "not base64!" } })).toBeNull();
    const previous = process.env.IRIS_MAX_TTS_AUDIO_BYTES;
    process.env.IRIS_MAX_TTS_AUDIO_BYTES = "44";
    resetRuntimeLimitsForTests();
    try {
      expect(parseGeneratedAudioResult({ _irisAudio: { base64: Buffer.alloc(45).toString("base64") } })).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.IRIS_MAX_TTS_AUDIO_BYTES;
      else process.env.IRIS_MAX_TTS_AUDIO_BYTES = previous;
      resetRuntimeLimitsForTests();
    }
  });

  it("passes through results without an audio envelope", () => {
    const d = deps();
    const result = { ok: true };
    expect(handleGeneratedAudio(result, metadata, d.deps)).toBe(result);
    expect(d.registerTransientAudio).not.toHaveBeenCalled();
  });

  it("rejects malformed audio without side effects", () => {
    const d = deps();
    expect(handleGeneratedAudio({ _irisAudio: { base64: 123 } }, metadata, d.deps)).toEqual({
      error: "provider returned invalid audio",
    });
    expect(d.cacheAudio).not.toHaveBeenCalled();
    expect(d.registerTransientAudio).not.toHaveBeenCalled();
  });

  it("caches, registers, and emits exactly once in order", () => {
    const d = deps({ enabled: true, maxAgeSeconds: 60, maxBytes: 100 });
    const result = handleGeneratedAudio({ _irisAudio: { base64: "AQID", mimeType: "audio/ogg" } }, metadata, d.deps);
    expect(result).toEqual({ ok: true, playback: "started", playbackId: "cached-1" });
    expect(d.order).toEqual(["cache", "register:3", "emit:transient-1"]);
    expect(d.cacheAudio).toHaveBeenCalledOnce();
    expect(d.registerTransientAudio).toHaveBeenCalledOnce();
    expect(d.emitAudioReady).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("AQID");
  });

  it("registers but does not cache when cache is disabled", () => {
    const d = deps({ enabled: false, maxAgeSeconds: 60, maxBytes: 100 });
    expect(handleGeneratedAudio({ _irisAudio: { base64: "AQ==" } }, metadata, d.deps)).toEqual({
      ok: true,
      playback: "started",
    });
    expect(d.cacheAudio).not.toHaveBeenCalled();
    expect(d.order).toEqual(["register:1", "emit:transient-1"]);
  });

  it("does not register or emit when caching fails", () => {
    const d = deps({ enabled: true, maxAgeSeconds: 60, maxBytes: 100 });
    d.cacheAudio.mockImplementation(() => {
      throw new Error("cache failure");
    });
    expect(() => handleGeneratedAudio({ _irisAudio: { base64: "AQ==" } }, metadata, d.deps)).toThrow("cache failure");
    expect(d.registerTransientAudio).not.toHaveBeenCalled();
    expect(d.emitAudioReady).not.toHaveBeenCalled();
  });

  it("does not emit when transient registration fails", () => {
    const d = deps();
    d.registerTransientAudio.mockImplementation(() => {
      throw new Error("registration failure");
    });
    expect(() => handleGeneratedAudio({ _irisAudio: { base64: "AQ==" } }, metadata, d.deps)).toThrow(
      "registration failure",
    );
    expect(d.emitAudioReady).not.toHaveBeenCalled();
  });

  it("discards the transient token when readiness delivery fails", () => {
    const d = deps();
    const discardTransientAudio = vi.fn();
    d.emitAudioReady.mockImplementation(() => {
      throw new Error("event sink failure");
    });
    expect(() =>
      handleGeneratedAudio({ _irisAudio: { base64: "AQ==" } }, metadata, {
        ...d.deps,
        discardTransientAudio,
      }),
    ).toThrow("event sink failure");
    expect(discardTransientAudio).toHaveBeenCalledWith("transient-1");
  });

  it("uses the shared strict bounded provider parser", () => {
    expect(parseGeneratedAudioResult({ _irisAudio: { base64: "AQ==" } })).toEqual({ base64: "AQ==" });
    expect(parseGeneratedAudioResult({ _irisAudio: { base64: "not base64!" } })).toBeNull();
    expect(parseGeneratedAudioResult({ _irisAudio: { base64: "AQ==", extra: "secret" } })).toBeNull();
    expect(parseGeneratedAudioResult({ _irisAudio: { base64: "AQ==", mimeType: "text/html" } })).toBeNull();
    expect(parseGeneratedAudioResult({ _irisAudio: { base64: "AQ==", mimeType: "audio/wav" } })).toEqual({
      base64: "AQ==",
      mimeType: "audio/wav",
    });
  });
});
