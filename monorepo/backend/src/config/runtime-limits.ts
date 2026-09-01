/** Runtime-configurable safety limits. This module intentionally has no setup or DB dependency. */
export interface RuntimeLimits {
  readonly jsonBodyBytes: number;
  readonly jsonBodyTimeoutMs: number;
  readonly attachmentBytes: number;
  readonly audioHandleBytes: number;
  readonly transientAudioEntries: number;
  readonly transientAudioBytes: number;
  readonly sttBytes: number;
  readonly openAiStreamBytes: number;
  readonly openAiSseLineBytes: number;
  readonly toolArgumentBytes: number;
  readonly toolArgumentDepth: number;
  readonly toolArgumentFields: number;
  readonly toolResultBytes: number;
  readonly toolStorageBytes: number;
  readonly searchResponseBytes: number;
  readonly ttsErrorBytes: number;
  readonly ttsRequestBytes: number;
  readonly ttsAudioBytes: number;
  readonly avatarBytes: number;
  readonly promptBytes: number;
  readonly promptImportBytes: number;
  readonly promptValueBytes: number;
  readonly promptKeyBytes: number;
  readonly promptCount: number;
  readonly logBytes: number;
  readonly comfyJsonDepth: number;
  readonly comfyJsonKeys: number;
  readonly comfyJsonStringBytes: number;
  readonly modelActive: number;
  readonly credentialActive: number;
  readonly configActive: number;
  readonly limiterKeyCapacity: number;
  readonly uploadPerWindow: number;
  readonly guestAccessPerWindow: number;
  readonly guestMessagesPerWindow: number;
  readonly serviceProbesPerWindow: number;
  readonly abuseWindowMs: number;
  readonly chatInstanceCacheEntries: number;
  readonly chatToolConfigEntries: number;
}

type RuntimeEnv = Record<string, string | undefined>;
type LimitSpec = { env: string; fallback: number; min: number; max: number };

const specs = {
  jsonBodyBytes: { env: "IRIS_MAX_JSON_BODY_BYTES", fallback: 1024 * 1024, min: 16 * 1024, max: 64 * 1024 * 1024 },
  jsonBodyTimeoutMs: { env: "IRIS_JSON_BODY_TIMEOUT_MS", fallback: 30_000, min: 100, max: 5 * 60_000 },
  attachmentBytes: { env: "IRIS_MAX_ATTACHMENT_BYTES", fallback: 10 * 1024 * 1024, min: 1, max: 256 * 1024 * 1024 },
  audioHandleBytes: { env: "IRIS_MAX_AUDIO_HANDLE_BYTES", fallback: 10 * 1024 * 1024, min: 1, max: 256 * 1024 * 1024 },
  transientAudioEntries: { env: "IRIS_MAX_TRANSIENT_AUDIO_ENTRIES", fallback: 256, min: 1, max: 4096 },
  transientAudioBytes: {
    env: "IRIS_MAX_TRANSIENT_AUDIO_BYTES",
    fallback: 256 * 1024 * 1024,
    min: 1,
    max: 1024 * 1024 * 1024,
  },
  sttBytes: { env: "IRIS_MAX_STT_BYTES", fallback: 25 * 1024 * 1024, min: 1, max: 256 * 1024 * 1024 },
  openAiStreamBytes: {
    env: "IRIS_MAX_OPENAI_STREAM_BYTES",
    fallback: 8 * 1024 * 1024,
    min: 64 * 1024,
    max: 256 * 1024 * 1024,
  },
  openAiSseLineBytes: {
    env: "IRIS_MAX_OPENAI_SSE_LINE_BYTES",
    fallback: 256 * 1024,
    min: 1024,
    max: 8 * 1024 * 1024,
  },
  toolArgumentBytes: { env: "IRIS_MAX_TOOL_ARGUMENT_BYTES", fallback: 64 * 1024, min: 1024, max: 4 * 1024 * 1024 },
  toolArgumentDepth: { env: "IRIS_MAX_TOOL_ARGUMENT_DEPTH", fallback: 16, min: 1, max: 64 },
  toolArgumentFields: { env: "IRIS_MAX_TOOL_ARGUMENT_FIELDS", fallback: 1024, min: 1, max: 100_000 },
  toolResultBytes: { env: "IRIS_MAX_TOOL_RESULT_BYTES", fallback: 256 * 1024, min: 1024, max: 16 * 1024 * 1024 },
  toolStorageBytes: { env: "IRIS_MAX_TOOL_STORAGE_BYTES", fallback: 256 * 1024, min: 1024, max: 16 * 1024 * 1024 },
  searchResponseBytes: {
    env: "IRIS_MAX_SEARCH_RESPONSE_BYTES",
    fallback: 2 * 1024 * 1024,
    min: 1024,
    max: 64 * 1024 * 1024,
  },
  ttsErrorBytes: { env: "IRIS_MAX_TTS_ERROR_BYTES", fallback: 64 * 1024, min: 1024, max: 4 * 1024 * 1024 },
  ttsRequestBytes: { env: "IRIS_MAX_TTS_REQUEST_BYTES", fallback: 2 * 1024 * 1024, min: 1024, max: 16 * 1024 * 1024 },
  ttsAudioBytes: { env: "IRIS_MAX_TTS_AUDIO_BYTES", fallback: 100 * 1024 * 1024, min: 44, max: 256 * 1024 * 1024 },
  avatarBytes: { env: "IRIS_MAX_AVATAR_BYTES", fallback: 256 * 1024, min: 1024, max: 4 * 1024 * 1024 },
  promptBytes: { env: "IRIS_MAX_PROMPT_BYTES", fallback: 1_000_000, min: 1, max: 16 * 1024 * 1024 },
  promptImportBytes: { env: "IRIS_MAX_PROMPT_IMPORT_BYTES", fallback: 4 * 1024 * 1024, min: 1, max: 64 * 1024 * 1024 },
  promptValueBytes: { env: "IRIS_MAX_PROMPT_VALUE_BYTES", fallback: 256 * 1024, min: 1, max: 16 * 1024 * 1024 },
  promptKeyBytes: { env: "IRIS_MAX_PROMPT_KEY_BYTES", fallback: 256, min: 1, max: 4096 },
  promptCount: { env: "IRIS_MAX_PROMPT_COUNT", fallback: 1_000, min: 1, max: 100_000 },
  logBytes: { env: "IRIS_MAX_LOG_BYTES", fallback: 5 * 1024 * 1024, min: 64 * 1024, max: 256 * 1024 * 1024 },
  comfyJsonDepth: { env: "IRIS_MAX_COMFY_JSON_DEPTH", fallback: 32, min: 1, max: 128 },
  comfyJsonKeys: { env: "IRIS_MAX_COMFY_JSON_KEYS", fallback: 10_000, min: 1, max: 1_000_000 },
  comfyJsonStringBytes: {
    env: "IRIS_MAX_COMFY_JSON_STRING_BYTES",
    fallback: 256 * 1024,
    min: 1024,
    max: 16 * 1024 * 1024,
  },
  modelActive: { env: "IRIS_MAX_ACTIVE_MODEL_REQUESTS", fallback: 2, min: 1, max: 256 },
  credentialActive: { env: "IRIS_MAX_ACTIVE_CREDENTIAL_OPERATIONS", fallback: 2, min: 1, max: 64 },
  configActive: { env: "IRIS_MAX_ACTIVE_CONFIG_OPERATIONS", fallback: 1, min: 1, max: 64 },
  limiterKeyCapacity: { env: "IRIS_LIMITER_KEY_CAPACITY", fallback: 20_000, min: 100, max: 1_000_000 },
  uploadPerWindow: { env: "IRIS_UPLOAD_LIMIT_PER_WINDOW", fallback: 10, min: 1, max: 10_000 },
  guestAccessPerWindow: { env: "IRIS_GUEST_ACCESS_LIMIT_PER_WINDOW", fallback: 30, min: 1, max: 10_000 },
  guestMessagesPerWindow: { env: "IRIS_GUEST_MESSAGE_LIMIT_PER_WINDOW", fallback: 20, min: 1, max: 10_000 },
  serviceProbesPerWindow: { env: "IRIS_SERVICE_PROBE_LIMIT_PER_WINDOW", fallback: 10, min: 1, max: 10_000 },
  abuseWindowMs: { env: "IRIS_ABUSE_WINDOW_MS", fallback: 60_000, min: 1_000, max: 86_400_000 },
  chatInstanceCacheEntries: { env: "IRIS_CHAT_INSTANCE_CACHE_ENTRIES", fallback: 256, min: 16, max: 4096 },
  chatToolConfigEntries: { env: "IRIS_CHAT_TOOL_CONFIG_ENTRIES", fallback: 256, min: 16, max: 4096 },
} satisfies Record<keyof RuntimeLimits, LimitSpec>;

function parseLimit(spec: LimitSpec, env: RuntimeEnv): number {
  const raw = env[spec.env];
  if (raw === undefined) return spec.fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`invalid ${spec.env}`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${spec.env}`);
  return Math.min(spec.max, Math.max(spec.min, parsed));
}

export function createRuntimeLimits(env: RuntimeEnv = process.env): RuntimeLimits {
  return Object.freeze({
    jsonBodyBytes: parseLimit(specs.jsonBodyBytes, env),
    jsonBodyTimeoutMs: parseLimit(specs.jsonBodyTimeoutMs, env),
    attachmentBytes: parseLimit(specs.attachmentBytes, env),
    audioHandleBytes: parseLimit(specs.audioHandleBytes, env),
    transientAudioEntries: parseLimit(specs.transientAudioEntries, env),
    transientAudioBytes: parseLimit(specs.transientAudioBytes, env),
    sttBytes: parseLimit(specs.sttBytes, env),
    openAiStreamBytes: parseLimit(specs.openAiStreamBytes, env),
    openAiSseLineBytes: parseLimit(specs.openAiSseLineBytes, env),
    toolArgumentBytes: parseLimit(specs.toolArgumentBytes, env),
    toolArgumentDepth: parseLimit(specs.toolArgumentDepth, env),
    toolArgumentFields: parseLimit(specs.toolArgumentFields, env),
    toolResultBytes: parseLimit(specs.toolResultBytes, env),
    toolStorageBytes: parseLimit(specs.toolStorageBytes, env),
    searchResponseBytes: parseLimit(specs.searchResponseBytes, env),
    ttsErrorBytes: parseLimit(specs.ttsErrorBytes, env),
    ttsRequestBytes: parseLimit(specs.ttsRequestBytes, env),
    ttsAudioBytes: parseLimit(specs.ttsAudioBytes, env),
    avatarBytes: parseLimit(specs.avatarBytes, env),
    promptBytes: parseLimit(specs.promptBytes, env),
    promptImportBytes: parseLimit(specs.promptImportBytes, env),
    promptValueBytes: parseLimit(specs.promptValueBytes, env),
    promptKeyBytes: parseLimit(specs.promptKeyBytes, env),
    promptCount: parseLimit(specs.promptCount, env),
    logBytes: parseLimit(specs.logBytes, env),
    comfyJsonDepth: parseLimit(specs.comfyJsonDepth, env),
    comfyJsonKeys: parseLimit(specs.comfyJsonKeys, env),
    comfyJsonStringBytes: parseLimit(specs.comfyJsonStringBytes, env),
    modelActive: parseLimit(specs.modelActive, env),
    credentialActive: parseLimit(specs.credentialActive, env),
    configActive: parseLimit(specs.configActive, env),
    limiterKeyCapacity: parseLimit(specs.limiterKeyCapacity, env),
    uploadPerWindow: parseLimit(specs.uploadPerWindow, env),
    guestAccessPerWindow: parseLimit(specs.guestAccessPerWindow, env),
    guestMessagesPerWindow: parseLimit(specs.guestMessagesPerWindow, env),
    serviceProbesPerWindow: parseLimit(specs.serviceProbesPerWindow, env),
    abuseWindowMs: parseLimit(specs.abuseWindowMs, env),
    chatInstanceCacheEntries: parseLimit(specs.chatInstanceCacheEntries, env),
    chatToolConfigEntries: parseLimit(specs.chatToolConfigEntries, env),
  });
}

let cached: RuntimeLimits | undefined;
export function readRuntimeLimits(): RuntimeLimits {
  cached ??= createRuntimeLimits();
  return cached;
}

export function resetRuntimeLimitsForTests(): void {
  cached = undefined;
}
