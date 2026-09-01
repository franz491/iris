import { describe, expect, it } from "vitest";

function request(argumentsValue: unknown) {
  return {
    name: "add_memory",
    arguments: argumentsValue as string,
    setting: { tool: "memory" },
    groupDef: { name: "memory", flavor: "provider" as const, provider: "memory", functions: [] },
    fnDef: { name: "add_memory", description: "", parameters: {}, functionality: "add_memory" },
  };
}

describe("provider tool argument boundary", () => {
  it("rejects prototype keys and excessive argument structure", async () => {
    const { parseToolArguments } = await import("../src/chat/tools.js");
    expect(() => parseToolArguments('{"__proto__":{}}')).toThrow(/unsafe/);
    expect(() => parseToolArguments(`{${Array.from({ length: 1025 }, (_, i) => `"k${i}":1`).join(",")}}`)).toThrow(
      /fields/,
    );
  });
  it("rejects malformed, non-object, and oversized JSON before provider dispatch", async () => {
    const { executeProviderTool, MAX_TOOL_ARGUMENT_BYTES } = await import("../src/chat/tools.js");
    for (const value of ["{", "null", "[]", `{"value":"${"x".repeat(MAX_TOOL_ARGUMENT_BYTES)}"}`]) {
      await expect(executeProviderTool(request(value), { chatId: "chat-1" })).rejects.toThrow(
        /invalid tool arguments JSON|must be an object|exceeds/,
      );
    }
  });

  it("keeps valid tool calls executable after an invalid neighboring call", async () => {
    const { parseToolCalls } = await import("../src/chat/tools.js");
    const calls = parseToolCalls(
      [
        { name: "add_memory", arguments: "{" },
        { name: "add_memory", arguments: JSON.stringify({ type: "self", keywords: ["valid"] }) },
      ],
      null,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].arguments).toContain("valid");
  });
});
