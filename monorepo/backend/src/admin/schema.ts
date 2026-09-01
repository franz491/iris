import { z } from "zod";

export const ADMIN_SCHEMA_VERSION = 1;
export const secretState = z.enum(["unset", "configured", "invalid"]);
export const serviceDefinition = z.object({
  name: z.string().min(1).max(128),
  kind: z.enum(["llm", "audio", "tts", "stt", "comfyui"]),
  mode: z.enum(["connect-only", "start-and-manage", "connect-or-start"]),
  endpoint: z.object({
    baseUrl: z.string().url(),
    healthCheck: z.object({ protocol: z.enum(["openai-model-list", "audio", "tts", "stt", "comfyui", "http"]) }),
    startupTimeoutSeconds: z.number().int().positive().max(3600).default(120),
  }),
  process: z
    .object({
      executable: z.string().min(1),
      arguments: z.array(z.string()),
      workingDirectory: z.string().optional(),
      environment: z.record(z.string()).default({}),
    })
    .optional(),
  audioCpp: z
    .object({
      modelId: z.string().min(1).max(128),
      family: z.string().min(1).max(128),
      modelPath: z.string().min(1),
      task: z.enum(["tts", "asr", "gen", "clon", "vc", "svc", "s2s"]).default("tts"),
      mode: z.enum(["offline", "streaming"]).default("offline"),
      backend: z.enum(["cpu", "cuda", "vulkan", "metal", "hip", "best"]).default("best"),
      device: z.number().int().nonnegative().default(0),
      threads: z.number().int().positive().max(1024).default(4),
      lazyLoad: z.boolean().default(true),
      defaultVoicePreset: z
        .object({
          voiceRef: z.string().optional(),
          referenceText: z.string().optional(),
          speaker: z.string().optional(),
        })
        .optional(),
      asrModel: z
        .object({
          modelId: z.string().min(1).max(128),
          family: z.string().min(1).max(128),
          modelPath: z.string().min(1),
          mode: z.enum(["offline", "streaming"]).default("offline"),
        })
        .optional(),
    })
    .optional(),
  shutdownPolicy: z.enum(["leave-running", "terminate-owned"]).default("leave-running"),
});
export const adminConfig = z.object({
  schemaVersion: z.literal(ADMIN_SCHEMA_VERSION),
  server: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    publicUrl: z.string().url(),
    trustedOrigins: z.array(z.string().url()),
    tls: z
      .object({
        mode: z.enum(["localhost-only", "existing-certificate", "self-signed", "reverse-proxy", "acme"]),
        hostname: z.string().optional(),
        certificatePath: z.string().optional(),
        keyPath: z.string().optional(),
      })
      .default({ mode: "localhost-only" }),
  }),
  services: z.array(serviceDefinition),
  profiles: z.array(
    z.object({
      name: z.string().min(1),
      service: z.string().min(1),
      model: z.string().optional(),
      acceleration: z.enum(["cpu", "cuda", "rocm", "vulkan", "metal", "remote"]).default("cpu"),
      fallback: z.string().optional(),
      inputAudio: z.boolean().default(false),
      sttService: z.string().optional(),
    }),
  ),
  secrets: z.record(secretState),
  tools: z.record(z.object({ active: z.array(z.string()), allowed: z.array(z.string()) })),
  prompts: z.record(z.string()),
  cache: z.object({
    enabled: z.boolean(),
    maxAgeSeconds: z.number().int().nonnegative(),
    maxBytes: z.number().int().nonnegative(),
  }),
});
export type AdminConfig = z.infer<typeof adminConfig>;
export type ChecklistState = "not configured" | "configured but untested" | "verified" | "explicitly skipped";
export interface ChecklistItem {
  id: string;
  group: string;
  state: ChecklistState;
}
export interface AuditEntry {
  id: string;
  actorId: string;
  action: string;
  createdAt: string;
  patchId?: string;
  details?: Record<string, unknown>;
}
export interface StagedPatch {
  id: string;
  actorId: string;
  baseVersion: number;
  patch: unknown;
  redactedDiff: unknown;
  status: "staged" | "validated" | "tested" | "applied" | "rolled-back" | "rejected";
  createdAt: string;
}
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    out[key] =
      /key|token|secret|password|credential|authorization/i.test(key) && (item === null || typeof item !== "object")
        ? item
          ? "configured"
          : "unset"
        : redactSecrets(item);
  return out;
}
