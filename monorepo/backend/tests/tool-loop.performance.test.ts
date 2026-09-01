import { describe, expect, it } from "vitest";

describe("tool-loop performance contract", () => {
  it("keeps bounded tool-call parsing deterministic across the loop budget", async () => {
    const { parseToolCalls } = await import("../src/chat/tools.js");
    const calls = Array.from({ length: 8 }, (_, i) => ({
      name: i % 2 === 0 ? "add_memory" : "unknown.tool",
      arguments: JSON.stringify({ value: `fixture-${i}` }),
    }));
    const config = { tools: [{ tool: "memory", settings: {} }] } as never;
    let accepted = 0;
    const iterations = 8;
    for (let i = 0; i < iterations; i++) {
      const parsed = parseToolCalls(calls, config);
      accepted += parsed.length;
      expect(parsed.every((call) => call.name === "add_memory")).toBe(true);
      expect(parsed.map((call) => call.name)).toEqual(["add_memory", "add_memory", "add_memory", "add_memory"]);
    }
    expect({ iterations, callsPerIteration: calls.length, accepted }).toEqual({
      iterations: 8,
      callsPerIteration: 8,
      accepted: 32,
    });
  });
});
