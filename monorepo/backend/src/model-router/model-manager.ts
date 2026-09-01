// model-router/model-manager.ts
// Receives all completion requests (including plugin/model info) and routes
// them to the right API interface based on AiParticipant.apiRouter.
import type { ApiRouter, CompletionRequest } from "./types.js";
import { OpenAiCompatRouter } from "./openai-compat.js";
import { LlamaCppRouter } from "./llamacpp.js";
import { getApiKey } from "./keys.js";
import type { AiParticipantBase } from "../chat/types.js";
import type { ChatContext } from "../chat/types.js";
import { AppError } from "../misc/error.js";
import { readSetupSettings } from "../setup/settings.js";
import { readRuntimeConfig, resolveProviderBaseUrl } from "../config/runtime.js";

const routers = new Map<string, ApiRouter>();

function routerFor(name: string): ApiRouter | undefined {
  const direct = routers.get(name);
  if (direct) return direct;
  const profile = readSetupSettings().providers[name];
  if (!profile) return undefined;
  const baseUrl = resolveProviderBaseUrl(readSetupSettings(), profile.router, profile.baseUrl);
  return profile.router === "llamacpp"
    ? new LlamaCppRouter(
        () => baseUrl,
        () => undefined,
      )
    : new OpenAiCompatRouter(
        () => baseUrl,
        () => undefined,
      );
}

// Generic OpenAI-compatible endpoints never assume provider-specific metadata.
const defaultOpenAi = new OpenAiCompatRouter(
  () => readRuntimeConfig().openAiCompatBaseUrl,
  () => process.env.IRIS_OPENAI_COMPAT_API_KEY,
);
routers.set("openai-compat", defaultOpenAi);
routers.set(
  "llamacpp",
  new LlamaCppRouter(
    () => readRuntimeConfig().llamacppBaseUrl,
    () => process.env.IRIS_LLAMACPP_API_KEY,
  ),
);

/** Register or replace a router implementation under an apiRouter name. */
export function registerApiRouter(name: string, router: ApiRouter): void {
  routers.set(name, router);
}

/**
 * Route a completion request for an AI participant through its configured API
 * router. The participant's apiAdditionalFields are merged into the request.
 */
export function routeCompletion(
  participant: Pick<AiParticipantBase, "model" | "apiRouter" | "apiAdditionalFields" | "apiKeyName">,
  context: ChatContext,
  opts: { stream?: boolean; tools?: unknown[]; toolChoice?: unknown } = {},
): AsyncIterable<import("./types.js").CompletionChunk> {
  const router = routerFor(participant.apiRouter);
  if (!router) throw new AppError(`unknown apiRouter "${participant.apiRouter}"`, "unknown_router");
  const req: CompletionRequest = {
    model: participant.model,
    context,
    stream: opts.stream ?? true,
    additionalFields: resolveKeyFields(participant),
    tools: opts.tools,
    toolChoice: opts.toolChoice,
  };
  return router.complete(req);
}

/**
 * Resolve the participant's named API key into request-level auth material.
 * The key value never leaves the process (used only for the Authorization header).
 */
function resolveKeyFields(participant: {
  apiRouter: string;
  apiAdditionalFields: Record<string, unknown>;
  apiKeyName?: string;
}): Record<string, unknown> {
  const fields = { ...participant.apiAdditionalFields };
  delete fields._apiKey;
  if (participant.apiKeyName) {
    const key = getApiKey(participant.apiKeyName);
    if (key) fields._apiKey = key;
  }
  const profile = readSetupSettings().providers[participant.apiRouter];
  if (profile?.apiKeyName && !fields._apiKey) {
    const key = getApiKey(profile.apiKeyName);
    if (key) fields._apiKey = key;
  }
  if (profile?.baseUrl) fields._baseUrl = resolveProviderBaseUrl(readSetupSettings(), profile.router, profile.baseUrl);
  return fields;
}

/** Models exposed by the given apiRouter (empty if unsupported/unreachable). */
export async function listModels(apiRouter = "llamacpp"): Promise<import("./types.js").ModelInfo[]> {
  const router = routerFor(apiRouter);
  if (!router?.listModels) return [];
  return router.listModels();
}

export function listRouters(): string[] {
  return ([...routers.keys()].filter((name) => name === "llamacpp" || name === "openai-compat") as string[]).concat(
    Object.keys(readSetupSettings().providers),
  );
}

export async function modelContextWindow(apiRouter: string, modelId: string): Promise<number | undefined> {
  if (apiRouter !== "llamacpp") return undefined;
  const model = (await listModels(apiRouter)).find((candidate) => candidate.id === modelId);
  return model?.contextWindow;
}

/** Non-streaming completion helper for callers that do not need token streaming. */
export async function routeCompletionOnce(
  participant: Pick<AiParticipantBase, "model" | "apiRouter" | "apiAdditionalFields" | "apiKeyName">,
  context: ChatContext,
  opts: { tools?: unknown[]; toolChoice?: unknown } = {},
): Promise<import("./types.js").CompletionResult> {
  const router = routerFor(participant.apiRouter);
  if (!router) throw new AppError(`unknown apiRouter "${participant.apiRouter}"`, "unknown_router");
  return router.completeOnce({
    model: participant.model,
    context,
    stream: false,
    additionalFields: resolveKeyFields(participant),
    tools: opts.tools,
    toolChoice: opts.toolChoice,
  });
}
