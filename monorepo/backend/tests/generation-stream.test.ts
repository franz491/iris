import { describe, expect, it } from "vitest";
import { collectGenerationStream } from "../src/chat/generation-stream.js";
import type { CompletionChunk } from "../src/model-router/types.js";

async function* chunks(values: CompletionChunk[]) {
  yield* values;
}

describe("generation stream collection", () => {
  it("preserves content/thought packet order and captures usage", async () => {
    const result = await collectGenerationStream(
      chunks([
        { thoughtDelta: "think " },
        { delta: "first" },
        { usage: { promptTokens: 42 } },
        { thoughtDelta: "more", delta: " second" },
      ]),
      new AbortController().signal,
      "ai-1",
    );
    expect(result.segments).toEqual([{ thought: "think more", content: "first second" }]);
    expect(result.promptTokens).toBe(42);
    expect(result.bufferedStream.map((packet) => packet.chunk)).toEqual([
      { thoughtDelta: "think " },
      { delta: "first" },
      { thoughtDelta: "more", delta: " second" },
    ]);
  });

  it("merges split tool fragments in index order and caps each iteration at eight", async () => {
    const raw = Array.from({ length: 10 }, (_, index) => ({
      toolCallDeltas: [{ index, id: `call-${index}`, name: "tool", arguments: "{}" }],
    }));
    const result = await collectGenerationStream(chunks(raw), new AbortController().signal, "ai-1");
    expect(result.toolCalls).toHaveLength(8);
    expect(result.toolCalls[0]).toEqual({ name: "tool", arguments: "{}" });
    expect(result.toolCalls.at(-1)).toEqual({ name: "tool", arguments: "{}" });
    expect(result.bufferedStream).toEqual([]);

    const split = await collectGenerationStream(
      chunks([
        { toolCallDeltas: [{ index: 1, id: "call", name: "to", arguments: "{" }] },
        { toolCallDeltas: [{ index: 1, name: "ol", arguments: "}" }] },
      ]),
      new AbortController().signal,
      "ai-1",
    );
    expect(split.toolCalls).toEqual([{ name: "tool", arguments: "{}" }]);
  });

  it("does not yield or buffer chunks when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let consumed = false;
    async function* source() {
      consumed = true;
      yield { delta: "must not escape" };
    }
    const result = await collectGenerationStream(source(), controller.signal, "ai-1");
    expect(consumed).toBe(true);
    expect(result.segments).toEqual([{ thought: "", content: "" }]);
    expect(result.bufferedStream).toEqual([]);
    expect(result.toolCalls).toEqual([]);
  });

  it("buffers reasoning-only deltas but never usage or finish-only chunks", async () => {
    const result = await collectGenerationStream(
      chunks([{ finishReason: "stop" }, { usage: { promptTokens: 7 } }, { thoughtDelta: "reasoning" }]),
      new AbortController().signal,
      "ai-1",
    );
    expect(result.promptTokens).toBe(7);
    expect(result.bufferedStream).toHaveLength(1);
    expect(result.bufferedStream[0]?.chunk).toEqual({ thoughtDelta: "reasoning" });
  });
});
