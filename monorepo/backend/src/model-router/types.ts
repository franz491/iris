// model-router/types.ts
import type { ChatContext } from "../chat/types.js";

export interface CompletionChunk {
  /** incremental text of the message content */
  delta?: string;
  /** incremental reasoning/thought text */
  thoughtDelta?: string;
  finishReason?: string;
  /** streamed tool-call fragment (OpenAI delta.tool_calls shape, merged by the caller) */
  toolCallDeltas?: { index: number; id?: string; name?: string; arguments?: string }[];
  /** OpenAI response usage, present on the final streamed chunk when supplied. */
  usage?: CompletionUsage;
}

export interface CompletionUsage {
  promptTokens: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface CompletionResult {
  content: string;
  thought?: string;
  /** tool calls requested by the model (OpenAI shape) */
  toolCalls?: { name: string; arguments: string }[];
  usage?: CompletionUsage;
}

export interface CompletionRequest {
  model: ModelId | string;
  context: ChatContext;
  stream: boolean;
  additionalFields: Record<string, unknown>;
  /** OpenAI-style tool definitions; resolved key passed via additionalFields._apiKey */
  tools?: unknown[];
  /** force a specific tool call, e.g. { type: "function", function: { name: "will_reply" } } */
  toolChoice?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ModelId = string;

export interface ModelInfo {
  id: string;
  /** Model context window, only when the provider exposes trustworthy metadata. */
  contextWindow?: number;
}

export interface ApiRouter {
  /** Send a completion request; returns an async iterable of chunks. */
  complete(req: CompletionRequest): AsyncIterable<CompletionChunk>;
  /** Non-streaming convenience wrapper (supports tool calls). */
  completeOnce(req: CompletionRequest): Promise<CompletionResult>;
  /** List models exposed by the backend API, if supported. */
  listModels?(): Promise<ModelInfo[]>;
}
