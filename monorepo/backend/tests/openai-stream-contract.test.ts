import { describe, expect, it } from "vitest";
import { normalizeStreamChunk, normalizedStreamEvent } from "../src/model-router/openai-compat.js";

describe("normalized provider stream contract", () => {
  it("normalizes delta, tool fragment, usage, and finish as version 1", () => {
    const events = normalizeStreamChunk({
      choices: [
        {
          delta: {
            content: "hi",
            reasoning_content: "why",
            tool_calls: [{ index: 2, id: "call", function: { name: "read", arguments: "{}" } }],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(events).toEqual([
      { version: 1, kind: "delta", content: "hi", reasoning: "why" },
      { version: 1, kind: "tool_call", index: 2, id: "call", name: "read", arguments: "{}" },
      { version: 1, kind: "usage", promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      { version: 1, kind: "finish", reason: "stop" },
    ]);
  });
  it.each([
    { version: 2, kind: "delta", content: "x" },
    { version: 1, kind: "unknown", content: "x" },
    { version: 1, kind: "finish", reason: "x".repeat(129) },
    { version: 1, kind: "tool_call", index: -1 },
    { version: 1, kind: "usage", promptTokens: Number.NaN },
  ])("rejects malformed normalized event %#", (event) => {
    expect(() => normalizedStreamEvent.parse(event)).toThrow();
  });
  it("bounds oversized delta and tool fields", () => {
    expect(() => normalizedStreamEvent.parse({ version: 1, kind: "delta", content: "x".repeat(262145) })).toThrow();
    expect(() =>
      normalizedStreamEvent.parse({ version: 1, kind: "tool_call", index: 0, arguments: "x".repeat(262145) }),
    ).toThrow();
  });
});
