// chat/utils.ts
import type { ChatContext, Message } from "./types.js";
import type { CompletionChunk } from "../model-router/types.js";
import { uuid } from "../misc/utils.js";

/**
 * Decompose a ChatContext (as returned as an API response from the AI) into
 * Message objects:
 * 1. all thoughts until an output are concatenated using \n\n
 * 2. subsequent thoughts are added to the subsequent outputs in a different Message
 * 3. if no output is found after thoughts, content is left "" (frontend shows *empty message*)
 */
export function buildMessages(ctx: ChatContext): Omit<Message, "id" | "chatId" | "authorId" | "createdAt">[] {
  const out: Omit<Message, "id" | "chatId" | "authorId" | "createdAt">[] = [];
  let pendingThought: string[] = [];

  const flushWith = (content: string) => {
    out.push({ type: "text", thought: pendingThought.join("\n\n"), content });
    pendingThought = [];
  };

  for (const m of ctx) {
    if (m.role === "assistant") {
      // multimodal content parts only appear in request context, never in AI
      // replies; stringify as a safe fallback
      flushWith(typeof m.content === "string" ? m.content : m.content ? JSON.stringify(m.content) : "");
    }
    // user/tool messages are not part of an AI reply decomposition
  }

  // trailing thoughts with no output after them
  if (pendingThought.length > 0) {
    out.push({ type: "text", thought: pendingThought.join("\n\n"), content: "" });
  }
  return out;
}

/** Accumulate a completion stream into final content/thought. */
export async function collectStream(
  chunks: AsyncIterable<CompletionChunk>,
  onChunk?: (c: CompletionChunk) => void,
): Promise<{ content: string; thought: string }> {
  let content = "";
  let thought = "";
  for await (const c of chunks) {
    if (c.delta) content += c.delta;
    if (c.thoughtDelta) thought += c.thoughtDelta;
    onChunk?.(c);
  }
  return { content, thought };
}

/** A reply segment: one visible message plus its own thinking block. */
export interface ReplySegment {
  content: string;
  thought: string;
}

/**
 * Accumulate a completion stream into ONE segment: the model reasons first,
 * then talks, then stops. All reasoning deltas land in `.thought`, all
 * content deltas in `.content` (returned as a 1-element array for compat).
 */
export async function collectStreamSegmented(
  chunks: AsyncIterable<CompletionChunk>,
  onChunk?: (c: CompletionChunk) => void,
): Promise<ReplySegment[]> {
  const seg: ReplySegment = { content: "", thought: "" };
  for await (const c of chunks) {
    if (c.thoughtDelta) seg.thought += c.thoughtDelta;
    if (c.delta) seg.content += c.delta;
    onChunk?.(c);
  }
  return [seg];
}

/** Merges streamed OpenAI-style tool_call fragments into complete calls. */
export class ToolCallAccumulator {
  private calls = new Map<number, { id?: string; name: string; arguments: string }>();

  feed(c: CompletionChunk): void {
    for (const d of c.toolCallDeltas ?? []) {
      const cur = this.calls.get(d.index) ?? { name: "", arguments: "" };
      if (d.id) cur.id = d.id;
      if (d.name) cur.name += d.name;
      if (d.arguments) cur.arguments += d.arguments;
      this.calls.set(d.index, cur);
    }
  }

  /** Complete calls in index order; empty when the stream had none. */
  finish(): { name: string; arguments: string }[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]) => ({ name: c.name, arguments: c.arguments }))
      .filter((c) => c.name.length > 0);
  }
}

export function newMessageId(): string {
  return uuid();
}
