import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseRouteId, parseStrictSingleQuery } from "../src/api/api-validation.js";

describe("shared API validation", () => {
  it("accepts bounded decoded IDs and rejects empty, control, and oversized values", () => {
    expect(parseRouteId("chat-1", "chat id")).toBe("chat-1");
    expect(() => parseRouteId("", "chat id")).toThrow("invalid chat id");
    expect(() => parseRouteId("bad\u0000id", "chat id")).toThrow("invalid chat id");
    expect(() => parseRouteId("x".repeat(257), "chat id")).toThrow("invalid chat id");
  });

  it("rejects duplicate or unknown query keys and preserves schema parsing", () => {
    const schema = z.object({ value: z.coerce.number().int() }).strict();
    expect(parseStrictSingleQuery(new Request("https://example.test/?value=3"), schema, "test")).toEqual({ value: 3 });
    expect(() => parseStrictSingleQuery(new Request("https://example.test/?value=1&value=2"), schema, "test")).toThrow(
      "invalid test query",
    );
    expect(() => parseStrictSingleQuery(new Request("https://example.test/?value=1&extra=x"), schema, "test")).toThrow(
      "invalid test query",
    );
  });
});
