import type { CacheLimits, PlaybackMetadata } from "../admin/audio-cache.js";
import { restoreCachedAudio } from "../admin/audio-cache.js";
import { parseGeneratedAudioResult } from "../chat/generation-audio-handler.js";
import { kernel } from "../runtime/kernel.js";

export interface AudioPlaybackGenerationDeps {
  generate: (input: {
    text: string;
    language?: string;
    voice?: string;
    instruct?: string;
    chatId?: string;
  }) => Promise<unknown>;
  restore: (id: string, bytes: Uint8Array, limits: CacheLimits, mimeType?: string) => boolean;
  parse: (value: unknown) => { base64: string; mimeType?: string } | null;
}

export function createAudioCachePlaybackService(
  overrides: Partial<AudioPlaybackGenerationDeps> = {},
): (id: string, metadata: PlaybackMetadata, limits: CacheLimits) => Promise<boolean> {
  const deps: AudioPlaybackGenerationDeps = {
    generate: (input) => kernel.useProviderContract("tts.synthesize", input),
    restore: restoreCachedAudio,
    parse: parseGeneratedAudioResult,
    ...overrides,
  };
  const pending = new Map<string, Promise<boolean>>();
  // Keep this wrapper non-async so concurrent callers for one ID receive the
  // exact same promise object, not merely equivalent eventual results.
  return function regeneratePlayback(id, metadata, limits): Promise<boolean> {
    const existing = pending.get(id);
    if (existing) return existing;
    const work = (async () => {
      try {
        const result = deps.parse(
          await deps.generate({
            text: metadata.text,
            language: metadata.language,
            voice: metadata.voice,
            instruct: metadata.style,
            chatId: metadata.chatId,
          }),
        );
        if (!result) return false;
        const bytes = Buffer.from(result.base64, "base64");
        return deps.restore(id, bytes, limits, result.mimeType ?? "audio/wav");
      } catch {
        return false;
      } finally {
        pending.delete(id);
      }
    })();
    pending.set(id, work);
    return work;
  };
}
