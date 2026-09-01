import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { z } from "zod";
import { dataFile } from "../db/sqlite.js";

export interface SetupSettings {
  version: 1;
  defaultModel: { apiRouter: string; model: string; maxContext: number; apiKeyName?: string };
  modelProviders: { llamacppBaseUrl: string; openAiCompatBaseUrl: string };
  providers: Record<string, { router: "openai-compat" | "llamacpp"; baseUrl: string; apiKeyName?: string }>;
  server: {
    host: string;
    port: number;
    publicUrl: string;
    trustedOrigins: string[];
  };
}

const DEFAULTS: SetupSettings = {
  version: 1,
  defaultModel: { apiRouter: "llamacpp", model: "", maxContext: 8192 },
  modelProviders: {
    llamacppBaseUrl: "http://localhost:8080/v1",
    openAiCompatBaseUrl: "https://api.openai.com/v1",
  },
  providers: {},
  server: {
    host: "127.0.0.1",
    port: 3000,
    publicUrl: "http://localhost:3000",
    trustedOrigins: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
    ],
  },
};

const providerSettingsSchema = z
  .object({
    router: z.enum(["openai-compat", "llamacpp"]),
    baseUrl: z.string(),
    apiKeyName: z.string().optional(),
  })
  .strict();

const setupSettingsFileSchema = z
  .object({
    version: z.literal(1).optional(),
    defaultModel: z
      .object({
        apiRouter: z.string(),
        model: z.string(),
        maxContext: z.number().finite(),
        apiKeyName: z.string().optional(),
      })
      .partial()
      .strict()
      .optional(),
    modelProviders: z
      .object({
        llamacppBaseUrl: z.string(),
        openAiCompatBaseUrl: z.string(),
      })
      .partial()
      .strict()
      .optional(),
    providers: z.record(providerSettingsSchema).optional(),
    server: z
      .object({
        host: z.string(),
        port: z.number().finite(),
        publicUrl: z.string(),
        trustedOrigins: z.array(z.string()),
      })
      .partial()
      .strict()
      .optional(),
  })
  .strict();

export function setupSettingsPath(): string {
  return dataFile("setup.json");
}

export function readSetupSettings(): SetupSettings {
  const file = setupSettingsPath();
  if (!existsSync(file)) return structuredClone(DEFAULTS);
  try {
    const parsed = setupSettingsFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return structuredClone(DEFAULTS);
    const value = parsed.data;
    return {
      ...structuredClone(DEFAULTS),
      ...value,
      defaultModel: { ...DEFAULTS.defaultModel, ...value.defaultModel },
      modelProviders: { ...DEFAULTS.modelProviders, ...value.modelProviders },
      providers: { ...DEFAULTS.providers, ...(value.providers ?? {}) },
      server: { ...DEFAULTS.server, ...value.server },
      version: 1,
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function writeSetupSettings(settings: SetupSettings): void {
  writeFileSync(setupSettingsPath(), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

export function localIpv4Addresses(): string[] {
  const out = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) out.add(entry.address);
    }
  }
  return [...out];
}

export function originMatches(origin: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i").test(origin);
  });
}
