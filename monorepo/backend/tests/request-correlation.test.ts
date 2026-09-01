import { describe, expect, it } from "vitest";
import { resolveRequestCorrelationId } from "../src/api/api.js";

describe("request correlation IDs", () => {
  it("preserves valid IDs and rejects malformed or oversized values", () => {
    expect(resolveRequestCorrelationId("client-42")).toBe("client-42");
    expect(resolveRequestCorrelationId("bad value")).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestCorrelationId("x".repeat(129))).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("generates unique UUIDs when absent", () => {
    expect(resolveRequestCorrelationId()).not.toBe(resolveRequestCorrelationId());
  });
});
