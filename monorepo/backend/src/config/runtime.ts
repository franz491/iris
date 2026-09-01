import { readSetupSettings, type SetupSettings } from "../setup/settings.js";

export interface RuntimeConfig {
  readonly hostname: string;
  readonly port: number;
  readonly guestChatKeep: number;
  readonly guestAiName: string;
  readonly guestModel: string;
  readonly publicUrl: string;
  readonly trustedOrigins: readonly string[];
  readonly llamacppBaseUrl: string;
  readonly openAiCompatBaseUrl: string;
}

type RuntimeEnv = Record<string, string | undefined>;

function parseHttpOrigin(value: string, label: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`invalid ${label}`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "" && parsed.pathname !== "/")
  ) {
    throw new Error(`invalid ${label}`);
  }
  return parsed.origin;
}

function parseTrustedOrigin(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Existing setup supports constrained LAN patterns such as 192.168.4.*:5173.
  // Validate those as origins by substituting a harmless host label, while
  // preserving the pattern for originMatches.
  const candidate = trimmed.replace(/\*/g, "wildcard");
  let parsed: URL;
  try {
    parsed = new URL(candidate);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "" && parsed.pathname !== "/")
    )
      return undefined;
  } catch {
    return undefined;
  }
  const normalized = parsed.origin.replace(/wildcard/g, "*");
  return normalized;
}

function parseServiceUrl(value: string, label: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`invalid ${label}`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`invalid ${label}`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export function resolveProviderBaseUrl(
  settings: SetupSettings,
  router: "llamacpp" | "openai-compat",
  profileBaseUrl?: string,
  env: RuntimeEnv = process.env,
): string {
  const configured =
    profileBaseUrl ??
    (router === "llamacpp"
      ? (env.IRIS_LLAMACPP_BASE_URL ?? settings.modelProviders.llamacppBaseUrl)
      : (env.IRIS_OPENAI_COMPAT_BASE_URL ?? settings.modelProviders.openAiCompatBaseUrl));
  return parseServiceUrl(configured, router === "llamacpp" ? "llama.cpp base URL" : "OpenAI-compatible base URL");
}

export function createRuntimeConfig(settings: SetupSettings, env: RuntimeEnv = process.env): RuntimeConfig {
  const hostname = (env.IRIS_HOST ?? settings.server.host).trim();
  if (!hostname || hostname.length > 253 || /[\s/\\]/.test(hostname)) throw new Error("invalid server host");
  const rawPort = env.IRIS_PORT ?? String(settings.server.port);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid server port");
  const rawGuestChatKeep = env.IRIS_GUEST_CHAT_KEEP ?? "200";
  const guestChatKeep = Number(rawGuestChatKeep);
  if (!Number.isInteger(guestChatKeep) || guestChatKeep < 1 || guestChatKeep > 100_000)
    throw new Error("invalid guest chat retention");
  const guestAiName = (env.IRIS_GUEST_AI_NAME ?? "iris").trim();
  if (!guestAiName || guestAiName.length > 256) throw new Error("invalid guest AI name");
  const configuredGuestModel = env.IRIS_GUEST_MODEL ?? env.IRIS_DEFAULT_MODEL;
  const guestModel = (configuredGuestModel ?? settings.defaultModel.model).trim();
  // An unset model is retained for a fresh, not-yet-configured setup. Once an
  // operator supplies an override, however, an empty/control-character value
  // is invalid. Model IDs are provider-defined, so do not restrict slashes,
  // colons, dots, or other punctuation used by real registries.
  if (
    (configuredGuestModel !== undefined && !guestModel) ||
    guestModel.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(guestModel)
  ) {
    throw new Error("invalid guest model");
  }
  const publicUrl = parseHttpOrigin(env.IRIS_PUBLIC_URL ?? settings.server.publicUrl, "public URL");
  const rawOrigins =
    env.IRIS_TRUSTED_ORIGINS === undefined ? settings.server.trustedOrigins : env.IRIS_TRUSTED_ORIGINS.split(",");
  const trustedOrigins = [
    ...new Set(rawOrigins.map(parseTrustedOrigin).filter((origin): origin is string => origin !== undefined)),
  ];
  const llamacppBaseUrl = resolveProviderBaseUrl(settings, "llamacpp", undefined, env);
  const openAiCompatBaseUrl = resolveProviderBaseUrl(settings, "openai-compat", undefined, env);
  return Object.freeze({
    hostname,
    port,
    guestChatKeep,
    guestAiName,
    guestModel,
    publicUrl,
    trustedOrigins: Object.freeze(trustedOrigins),
    llamacppBaseUrl,
    openAiCompatBaseUrl,
  });
}

let cached: RuntimeConfig | undefined;
export function readRuntimeConfig(): RuntimeConfig {
  cached ??= createRuntimeConfig(readSetupSettings());
  return cached;
}
