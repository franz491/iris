import { describe, expect, it } from "vitest";
import { parseToolArguments, MAX_TOOL_ARGUMENT_BYTES } from "../src/chat/tools.js";

describe("provider tool argument boundary", () => {
  it("accepts JSON objects", () => expect(parseToolArguments('{"value":1}')).toEqual({ value: 1 }));
  it.each(["[]", "null", "not-json"])("rejects %s", (raw) => expect(() => parseToolArguments(raw)).toThrow());
  it("rejects oversized JSON before parsing", () => {
    expect(() => parseToolArguments(JSON.stringify({ value: "x".repeat(MAX_TOOL_ARGUMENT_BYTES) }))).toThrow(/exceeds/);
  });
});
