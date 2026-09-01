import type { CompletionChunk } from "../model-router/types.js";
import { collectStreamSegmented, ToolCallAccumulator, type ReplySegment } from "./utils.js";

export interface GenerationStreamResult {
  segments: ReplySegment[];
  toolCalls: { name: string; arguments: string }[];
  bufferedStream: Array<{ kind: "stream"; participantId: string; chunk: CompletionChunk }>;
  promptTokens?: number;
}

/** Collect one provider iteration; revision, tool execution, and persistence stay with ChatInstance. */
export async function collectGenerationStream(
  chunks: AsyncIterable<CompletionChunk>,
  signal: AbortSignal,
  participantId: string,
  onChunk?: (chunk: CompletionChunk) => void,
): Promise<GenerationStreamResult> {
  const accumulator = new ToolCallAccumulator();
  const bufferedStream: GenerationStreamResult["bufferedStream"] = [];
  let promptTokens: number | undefined;
  const segments = await collectStreamSegmented(withAbort(chunks, signal), (chunk) => {
    if (onChunk && (chunk.delta || chunk.thoughtDelta)) onChunk(chunk);
    if (chunk.usage) promptTokens = chunk.usage.promptTokens;
    accumulator.feed(chunk);
    if (chunk.delta || chunk.thoughtDelta) bufferedStream.push({ kind: "stream", participantId, chunk });
  });
  return { segments, toolCalls: accumulator.finish().slice(0, 8), bufferedStream, promptTokens };
}

async function* withAbort<T>(iter: AsyncIterable<T>, signal: AbortSignal): AsyncIterable<T> {
  for await (const item of iter) {
    if (signal.aborted) return;
    yield item;
  }
}
