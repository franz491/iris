import { parseProviderContract } from "../providers/contracts.js";
import { readRuntimeLimits } from "../config/runtime-limits.js";

export interface GeneratedAudio {
  base64: string;
  mimeType?: string;
}

/** Validate the bounded provider audio envelope without importing the API layer. */
export function parseGeneratedAudioResult(value: unknown): GeneratedAudio | null {
  try {
    const parsed = parseProviderContract("tts.synthesize", value);
    const audio = parsed._irisAudio;
    if (!audio || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(audio.base64)) return null;
    if (audio.mimeType !== undefined && !/^audio\/[A-Za-z0-9.+-]+$/.test(audio.mimeType)) return null;
    const bytes = Buffer.from(audio.base64, "base64");
    if (bytes.toString("base64") !== audio.base64 || bytes.byteLength > readRuntimeLimits().ttsAudioBytes) return null;
    return audio;
  } catch {
    return null;
  }
}

export interface AudioCacheConfig {
  enabled: boolean;
  maxAgeSeconds: number;
  maxBytes: number;
}

export interface GeneratedAudioMetadata {
  text: string;
  language?: string;
  voice?: string;
  style?: string;
  chatId: string;
}

export interface GeneratedAudioHandlerDeps {
  cache?: AudioCacheConfig;
  cacheAudio: (
    bytes: Buffer,
    metadata: GeneratedAudioMetadata & { service: "tts" },
    limits: AudioCacheConfig,
    mimeType: string,
  ) => string;
  registerTransientAudio: (chatId: string, bytes: Buffer, mimeType: string) => string;
  discardTransientAudio?: (token: string) => void;
  emitAudioReady: (token: string) => void;
}

/** Convert provider TTS output into the bounded tool result and playback event. */
export function handleGeneratedAudio(
  result: unknown,
  metadata: GeneratedAudioMetadata,
  deps: GeneratedAudioHandlerDeps,
): unknown {
  const hasAudioEnvelope =
    result !== null && typeof result === "object" && !Array.isArray(result) && "_irisAudio" in result;
  if (!hasAudioEnvelope) return result;

  const audio = parseGeneratedAudioResult(result);
  if (!audio) return { error: "provider returned invalid audio" };

  const mimeType = audio.mimeType ?? "audio/wav";
  const bytes = Buffer.from(audio.base64, "base64");
  const playbackId = deps.cache?.enabled
    ? deps.cacheAudio(bytes, { ...metadata, service: "tts" }, deps.cache, mimeType)
    : undefined;
  const token = deps.registerTransientAudio(metadata.chatId, bytes, mimeType);
  try {
    deps.emitAudioReady(token);
  } catch (error) {
    // Do not leave an unreachable in-memory playback handle alive when the
    // event sink rejects delivery. Cache persistence remains independently
    // owned and can be evicted normally.
    deps.discardTransientAudio?.(token);
    throw error;
  }
  return { ok: true, playback: "started", ...(playbackId ? { playbackId } : {}) };
}
