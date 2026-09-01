import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAudioHandle, readAudioHandle } from "../src/api/audio-handles.js";
import { registerTransientAudio, getTransientAudio } from "../src/api/transient-audio.js";

beforeEach(() => {
  process.env.IRIS_MAX_TRANSIENT_AUDIO_ENTRIES = "1";
  process.env.IRIS_MAX_TRANSIENT_AUDIO_BYTES = "4";
  process.env.IRIS_MAX_AUDIO_HANDLE_BYTES = "4";
  vi.resetModules();
});
describe("opaque audio handles", () =>
  it("never crosses chat/user boundaries", () => {
    const id = createAudioHandle("chat-a", "user-a", Buffer.from([1, 2]));
    expect(readAudioHandle(id, "chat-b", "user-a")).toBeNull();
    expect(readAudioHandle(id, "chat-a", "user-b")).toBeNull();
    expect(readAudioHandle(id, "chat-a", "user-a")?.bytes).toEqual(Buffer.from([1, 2]));
  }));

it("bounds transient audio by entries and bytes and normalizes MIME", () => {
  const first = registerTransientAudio("chat-a", Buffer.from([1, 2]), "audio/WAV; codec=pcm");
  expect(getTransientAudio(first)?.mimeType).toBe("audio/wav");
  const second = registerTransientAudio("chat-a", Buffer.from([3, 4]), "audio/ogg");
  expect(getTransientAudio(first)).toBeNull();
  expect(getTransientAudio(second)?.bytes).toEqual(Buffer.from([3, 4]));
  expect(() => registerTransientAudio("chat-a", Buffer.alloc(5))).toThrow("configured limit");
  expect(() => registerTransientAudio("chat-a", Buffer.from([1]), "text/plain")).toThrow("MIME");
});
