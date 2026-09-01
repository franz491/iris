// model-router/openai-compat.ts
// Simple router that forwards all internal requests as-is to an
// OpenAI-compatible chat-completions endpoint. Preinstalled.
import type { ApiRouter, CompletionChunk, CompletionRequest, CompletionResult, ModelInfo } from "./types.js";
import { errorEvent, eventRecord, logger } from "../misc/logging.js";
import { pinnedFetch, pinnedFetchStream } from "../net/pinned-http.js";
import { parseModelCatalog } from "../providers/contracts.js";
import { z } from "zod";
import { readRuntimeLimits } from "../config/runtime-limits.js";

const log = logger("openai-compat");
// Keep an untrusted provider from making the completion process retain an
// unbounded SSE response or a single never-terminated event line.
// Compatibility callers still receive the same default through RuntimeLimits;
// enforcement reads the cached process policy per request.

type UrlFn = () => string;
type KeyFn = () => string | undefined;

function recordField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Provider model IDs are opaque, but must remain bounded and printable before entering UI/state. */
export function isSafeModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Normalize the only explicitly supported reasoning channel. Content markers
 * such as literal or malformed `<think>` tags remain visible content; they are
 * never heuristically reclassified as hidden reasoning.
 */
export function normalizeReasoning(
  content: string | undefined,
  explicitThought: string | undefined,
): {
  content: string;
  thought?: string;
} {
  return { content: content ?? "", thought: explicitThought || undefined };
}

type StreamToolCall = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type StreamChoice = {
  delta?: {
    content?: string;
    reasoning_content?: string;
    tool_calls?: StreamToolCall[];
  };
  finish_reason?: string | null;
};

type StreamUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type StreamChunk = {
  choices: StreamChoice[];
  usage?: StreamUsage;
};

/** Versioned internal representation of an accepted provider stream packet. */
export const normalizedStreamEvent = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1),
    kind: z.literal("delta"),
    content: z.string().max(262144).optional(),
    reasoning: z.string().max(262144).optional(),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("tool_call"),
    index: z.number().int().nonnegative(),
    id: z.string().max(512).optional(),
    name: z.string().max(512).optional(),
    arguments: z.string().max(262144).optional(),
  }),
  z.object({
    version: z.literal(1),
    kind: z.literal("usage"),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  }),
  z.object({ version: z.literal(1), kind: z.literal("finish"), reason: z.string().max(128).optional() }),
]);
export type NormalizedStreamEvent = z.infer<typeof normalizedStreamEvent>;

export function normalizeStreamChunk(chunk: StreamChunk): NormalizedStreamEvent[] {
  const choice = chunk.choices[0];
  const events: NormalizedStreamEvent[] = [];
  if (choice?.delta?.content !== undefined || choice?.delta?.reasoning_content !== undefined)
    events.push({
      version: 1,
      kind: "delta",
      content: choice.delta.content,
      reasoning: choice.delta.reasoning_content,
    });
  for (const [i, call] of (choice?.delta?.tool_calls ?? []).entries())
    events.push({
      version: 1,
      kind: "tool_call",
      index: call.index ?? i,
      id: call.id,
      name: call.function?.name,
      arguments: call.function?.arguments,
    });
  if (chunk.usage?.prompt_tokens !== undefined)
    events.push({
      version: 1,
      kind: "usage",
      promptTokens: chunk.usage.prompt_tokens,
      completionTokens: chunk.usage.completion_tokens,
      totalTokens: chunk.usage.total_tokens,
    });
  if (choice?.finish_reason) events.push({ version: 1, kind: "finish", reason: choice.finish_reason });
  return events.map((event) => normalizedStreamEvent.parse(event));
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function parseCompletionResult(value: unknown): CompletionResult {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("openai-compat returned invalid response");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.choices) || !body.choices.length) throw new Error("openai-compat returned invalid response");
  const choice = body.choices[0];
  if (!choice || typeof choice !== "object" || Array.isArray(choice))
    throw new Error("openai-compat returned invalid response");
  const message = (choice as Record<string, unknown>).message;
  if (!message || typeof message !== "object" || Array.isArray(message))
    throw new Error("openai-compat returned invalid response");
  const m = message as Record<string, unknown>;
  if (
    (m.content !== undefined && typeof m.content !== "string") ||
    (m.reasoning_content !== undefined && typeof m.reasoning_content !== "string")
  )
    throw new Error("openai-compat returned invalid response");
  const calls = m.tool_calls;
  if (
    calls !== undefined &&
    (!Array.isArray(calls) ||
      calls.some((call) => {
        if (!call || typeof call !== "object" || Array.isArray(call)) return true;
        const fn = (call as Record<string, unknown>).function;
        return (
          !fn ||
          typeof fn !== "object" ||
          Array.isArray(fn) ||
          typeof (fn as Record<string, unknown>).name !== "string" ||
          typeof (fn as Record<string, unknown>).arguments !== "string"
        );
      }))
  )
    throw new Error("openai-compat returned invalid response");
  const usage = body.usage;
  if (
    usage !== undefined &&
    (!usage ||
      typeof usage !== "object" ||
      Array.isArray(usage) ||
      !isOptionalNumber((usage as Record<string, unknown>).prompt_tokens) ||
      !isOptionalNumber((usage as Record<string, unknown>).completion_tokens) ||
      !isOptionalNumber((usage as Record<string, unknown>).total_tokens))
  )
    throw new Error("openai-compat returned invalid response");
  const usageRecord = usage as Record<string, unknown> | undefined;
  const normalized = normalizeReasoning(
    typeof m.content === "string" ? m.content : undefined,
    typeof m.reasoning_content === "string" ? m.reasoning_content : undefined,
  );
  return {
    content: normalized.content,
    thought: normalized.thought,
    toolCalls: Array.isArray(calls)
      ? calls.map((call) => {
          const fn = (call as Record<string, unknown>).function as Record<string, string>;
          return { name: fn.name, arguments: fn.arguments };
        })
      : undefined,
    usage:
      usageRecord?.prompt_tokens == null
        ? undefined
        : {
            promptTokens: usageRecord.prompt_tokens as number,
            completionTokens: usageRecord.completion_tokens as number | undefined,
            totalTokens: usageRecord.total_tokens as number | undefined,
          },
  };
}

function isStreamChunk(value: unknown): value is StreamChunk {
  if (!recordField(value, "choices") || !Array.isArray(recordField(value, "choices"))) return false;
  const choices = recordField(value, "choices") as unknown[];
  const usageValue = recordField(value, "usage");
  if (usageValue !== undefined) {
    if (
      !recordField(value, "usage") ||
      !isOptionalNumber(recordField(usageValue, "prompt_tokens")) ||
      !isOptionalNumber(recordField(usageValue, "completion_tokens")) ||
      !isOptionalNumber(recordField(usageValue, "total_tokens"))
    )
      return false;
  }
  return choices.every((choiceValue) => {
    if (!recordField(choiceValue, "delta") && recordField(choiceValue, "delta") !== undefined) return false;
    const choice = recordValue(choiceValue);
    if (choiceValue === null || typeof choiceValue !== "object" || Array.isArray(choiceValue)) return false;
    if (
      choice.finish_reason !== undefined &&
      choice.finish_reason !== null &&
      (typeof choice.finish_reason !== "string" || choice.finish_reason.length > 128)
    )
      return false;
    const deltaValue = choice.delta;
    if (deltaValue === undefined) return true;
    if (typeof deltaValue !== "object" || deltaValue === null || Array.isArray(deltaValue)) return false;
    const delta = deltaValue as Record<string, unknown>;
    if (delta.content !== undefined && (typeof delta.content !== "string" || delta.content.length > 262144))
      return false;
    if (
      delta.reasoning_content !== undefined &&
      (typeof delta.reasoning_content !== "string" || delta.reasoning_content.length > 262144)
    )
      return false;
    if (
      delta.tool_calls !== undefined &&
      (!Array.isArray(delta.tool_calls) ||
        !delta.tool_calls.every((toolCall) => {
          if (typeof toolCall !== "object" || toolCall === null || Array.isArray(toolCall)) return false;
          const call = toolCall as Record<string, unknown>;
          if (call.index !== undefined && typeof call.index !== "number") return false;
          if (call.id !== undefined && typeof call.id !== "string") return false;
          if (call.function === undefined) return true;
          if (typeof call.function !== "object" || call.function === null || Array.isArray(call.function)) return false;
          const fn = call.function as Record<string, unknown>;
          return (
            (fn.name === undefined || typeof fn.name === "string") &&
            (fn.arguments === undefined || typeof fn.arguments === "string")
          );
        }))
    )
      return false;
    return true;
  });
}

export class OpenAiCompatRouter implements ApiRouter {
  constructor(
    protected readonly baseUrl: UrlFn,
    private readonly apiKey: KeyFn = () => undefined,
  ) {}

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    const key = this.apiKey();
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  protected supportsStreamOptions(_req: CompletionRequest): boolean {
    return true;
  }

  protected body(req: CompletionRequest, stream: boolean): Record<string, unknown> {
    const additional = Object.fromEntries(
      Object.entries(recordValue(req.additionalFields)).filter(([key]) => !key.startsWith("_")),
    );
    return {
      ...additional,
      model: req.model,
      messages: req.context,
      stream,
      ...(stream && this.supportsStreamOptions(req) ? { stream_options: { include_usage: true } } : {}),
      tools: req.tools,
      tool_choice: req.toolChoice,
    };
  }

  private headersFor(req: CompletionRequest): Record<string, string> {
    const h = this.headers();
    // key resolved by name upstream; request-level override wins over env
    const requestKey = recordField(req.additionalFields, "_apiKey");
    const key = (typeof requestKey === "string" ? requestKey : undefined) ?? this.apiKey();
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  complete(req: CompletionRequest): AsyncIterableIterator<CompletionChunk> {
    const controller = new AbortController();
    const signal = req.signal;
    let consumerReturned = false;
    let terminate!: (result: IteratorResult<CompletionChunk>) => void;
    const terminated = new Promise<IteratorResult<CompletionChunk>>((resolve) => {
      terminate = resolve;
    });
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    const iterator = this.completeStream({ ...req, signal: controller.signal });
    return {
      next: async (value?: unknown) => {
        if (consumerReturned) return terminated;
        const pending = iterator.next(value);
        // The underlying generator may reject after return() wins the race;
        // attach a handler so cancellation cannot create an unhandled rejection.
        void pending.catch(() => undefined);
        return Promise.race([pending, terminated]);
      },
      return: async (value?: unknown) => {
        consumerReturned = true;
        terminate({ done: true, value: value as never });
        controller.abort();
        void iterator.return(value).catch(() => undefined);
        return { done: true, value: value as never };
      },
      throw: async (error?: unknown) => {
        controller.abort(error);
        return iterator.throw(error);
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  private async *completeStream(req: CompletionRequest): AsyncGenerator<CompletionChunk> {
    const limits = readRuntimeLimits();
    log.info(
      JSON.stringify(
        eventRecord("openai-compat", "completion.start", {
          stream: req.stream,
          messageCount: Math.min(req.context.length, 1024),
        }),
      ),
    );
    if (!req.stream) {
      const r = await this.completeOnce(req);
      if (r.thought) yield { thoughtDelta: r.thought };
      yield { delta: r.content, finishReason: "stop" };
      return;
    }
    const requestBaseUrl = recordField(req.additionalFields, "_baseUrl");
    const baseUrl = typeof requestBaseUrl === "string" ? requestBaseUrl : this.baseUrl();
    let res = await pinnedFetchStream(
      new URL(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`),
      {
        method: "POST",
        headers: this.headersFor(req),
        body: JSON.stringify(this.body(req, true)),
        signal: req.signal,
      },
      limits.openAiStreamBytes,
      req.timeoutMs ?? 0,
    );
    log.info(JSON.stringify(eventRecord("openai-compat", "completion.response", { stream: true, status: res.status })));
    if (!res.ok || !res.body) {
      const diagnostic = res.ok ? "missing response body" : "upstream error";
      log.error(
        JSON.stringify(
          errorEvent(
            "openai-compat",
            "completion.failed",
            "upstream_http_error",
            undefined,
            new Error(`status ${res.status}; ${diagnostic}`),
          ),
        ),
      );
      throw new Error(`openai-compat request failed: ${res.status}; ${diagnostic}`);
    }
    // parse SSE
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let responseBytes = 0;
    let reachedEof = false;
    let cancelled = false;
    const cancelReader = async (reason: string) => {
      if (cancelled || reachedEof) return;
      cancelled = true;
      await reader.cancel(reason);
    };
    try {
      while (true) {
        let packet: ReadableStreamReadResult<Uint8Array>;
        packet = await reader.read();
        const { done, value } = packet;
        if (done) {
          reachedEof = true;
          break;
        }
        responseBytes += value.byteLength;
        if (responseBytes > limits.openAiStreamBytes) {
          await cancelReader("OpenAI-compatible stream exceeded response size limit");
          throw new Error(`openai-compat stream exceeded ${limits.openAiStreamBytes} byte limit`);
        }
        buffer += decoder.decode(value, { stream: true });
        const lastNewline = buffer.lastIndexOf("\n");
        if (encoder.encode(buffer.slice(lastNewline + 1)).byteLength > limits.openAiSseLineBytes) {
          await cancelReader("OpenAI-compatible SSE line exceeded size limit");
          throw new Error(`openai-compat SSE line exceeded ${limits.openAiSseLineBytes} byte limit`);
        }
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const rawLine = buffer.slice(0, idx);
          if (encoder.encode(rawLine).byteLength > limits.openAiSseLineBytes) {
            await cancelReader("OpenAI-compatible SSE line exceeded size limit");
            throw new Error(`openai-compat SSE line exceeded ${limits.openAiSseLineBytes} byte limit`);
          }
          const line = rawLine.trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            const json: unknown = JSON.parse(data);
            if (!isStreamChunk(json)) continue;
            const normalized = normalizeStreamChunk(json);
            const choice = json.choices[0];
            const usage =
              json.usage?.prompt_tokens == null
                ? undefined
                : {
                    promptTokens: json.usage.prompt_tokens,
                    completionTokens: json.usage.completion_tokens,
                    totalTokens: json.usage.total_tokens,
                  };
            if (choice || usage) {
              for (const event of normalized)
                yield event.kind === "delta"
                  ? { delta: event.content, thoughtDelta: normalizeReasoning(undefined, event.reasoning).thought }
                  : event.kind === "tool_call"
                    ? {
                        toolCallDeltas: [
                          { index: event.index, id: event.id, name: event.name, arguments: event.arguments },
                        ],
                      }
                    : event.kind === "usage"
                      ? {
                          usage: {
                            promptTokens: event.promptTokens,
                            completionTokens: event.completionTokens,
                            totalTokens: event.totalTokens,
                          },
                        }
                      : { finishReason: event.reason };
            }
          } catch {
            // ignore malformed keep-alive lines
          }
        }
      }
    } finally {
      await cancelReader("OpenAI-compatible stream consumer stopped");
    }
  }

  async completeOnce(req: CompletionRequest): Promise<CompletionResult> {
    const requestBaseUrl = recordField(req.additionalFields, "_baseUrl");
    const baseUrl = typeof requestBaseUrl === "string" ? requestBaseUrl : this.baseUrl();
    const body = JSON.stringify(this.body(req, false));
    const responseBytes = readRuntimeLimits().openAiStreamBytes;
    if (Buffer.byteLength(body, "utf8") > responseBytes) {
      throw new Error(`openai-compat request exceeded ${responseBytes} byte limit`);
    }
    const res = await pinnedFetch(
      new URL(`${String(baseUrl).replace(/\/$/, "")}/chat/completions`),
      {
        method: "POST",
        headers: this.headersFor(req),
        body,
        signal: req.signal,
      },
      responseBytes,
      req.timeoutMs ?? 0,
    );
    log.info(
      JSON.stringify(eventRecord("openai-compat", "completion.response", { stream: false, status: res.status })),
    );
    if (!res.ok) {
      const diagnostic = "upstream error";
      log.error(
        JSON.stringify(
          errorEvent(
            "openai-compat",
            "completion.failed",
            "upstream_http_error",
            undefined,
            new Error(`status ${res.status}; ${diagnostic}`),
          ),
        ),
      );
      throw new Error(`openai-compat request failed: ${res.status}; ${diagnostic}`);
    }
    return parseCompletionResult(await res.json());
  }
  async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await pinnedFetch(
        new URL(`${this.baseUrl().replace(/\/$/, "")}/models`),
        { headers: this.headers() },
        2 * 1024 * 1024,
      );
      if (!res.ok) return [];
      const json: unknown = await res.json();
      return parseModelCatalog(json);
    } catch {
      return []; // server unreachable -> empty dropdown
    }
  }
}
