import { describe, expect, it } from "vitest";
import { appendAssistantToolCalls, appendToolResult } from "../src/chat/generation-tool-context.js";
import type { ChatContext } from "../src/chat/types.js";

describe("generation tool context", () => {
  it("constructs deterministic IDs and preserves the prior context immutably", () => {
    const original: ChatContext = [{ role: "user", content: "hello" }];
    const calls = [
      { name: "files.read", arguments: '{"path":"a"}' },
      { name: "files.write", arguments: '{"path":"b"}' },
    ];
    const result = appendAssistantToolCalls(original, "ai-1", 3, calls);
    expect(original).toEqual([{ role: "user", content: "hello" }]);
    expect(result.callIds).toEqual(["iris-loop-ai-1-3-0", "iris-loop-ai-1-3-1"]);
    expect(result.context).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "iris-loop-ai-1-3-0", type: "function", function: { name: "files.read", arguments: '{"path":"a"}' } },
          { id: "iris-loop-ai-1-3-1", type: "function", function: { name: "files.write", arguments: '{"path":"b"}' } },
        ],
      },
    ]);
  });

  it("appends tool results in call order with the existing eight-kilobyte bound", () => {
    const base: ChatContext = [{ role: "assistant", content: null, tool_calls: [] }];
    const first = appendToolResult(base, "call-0", { ok: true });
    const second = appendToolResult(first, "call-1", { payload: "x".repeat(9_000) });
    expect(base).toHaveLength(1);
    expect(second).toHaveLength(3);
    expect(second[1]).toEqual({ role: "tool", tool_call_id: "call-0", content: '{"ok":true}' });
    expect(second[2]?.role).toBe("tool");
    expect(String(second[2]?.content)).toHaveLength(8_000);
  });

  it("keeps iteration and participant IDs distinct for repeated tool names", () => {
    const one = appendAssistantToolCalls([], "ai-1", 0, [{ name: "same", arguments: "{}" }]);
    const two = appendAssistantToolCalls([], "ai-1", 1, [{ name: "same", arguments: "{}" }]);
    const other = appendAssistantToolCalls([], "ai-2", 0, [{ name: "same", arguments: "{}" }]);
    expect(new Set([one.callIds[0], two.callIds[0], other.callIds[0]]).size).toBe(3);
  });

  it("keeps duplicate calls in one batch distinct by occurrence", () => {
    const result = appendAssistantToolCalls([], "ai-1", 0, [
      { name: "same", arguments: "{}" },
      { name: "same", arguments: "{}" },
    ]);
    expect(result.callIds).toEqual(["iris-loop-ai-1-0-0", "iris-loop-ai-1-0-1"]);
    expect(result.context[0]?.role).toBe("assistant");
    expect((result.context[0] as { tool_calls: Array<{ id: string }> }).tool_calls.map((call) => call.id)).toEqual(
      result.callIds,
    );
  });
});
