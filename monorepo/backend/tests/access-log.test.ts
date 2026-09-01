import { describe, expect, it } from "vitest";
import { accessLogRecord } from "../src/api/api.js";

describe("access log record", () => {
  it("keeps pathname and excludes query/header/body data", () => {
    const record = accessLogRecord("req-1", "POST", "http://x.test/api?q=secret-query", 400, Date.now());
    expect(record).toMatchObject({
      component: "http",
      event: "request.completed",
      correlationId: "req-1",
      level: "warn",
      requestId: "req-1",
      method: "POST",
      path: "/api",
      status: 400,
    });
    expect(JSON.stringify(record)).not.toContain("secret-query");
    expect(JSON.stringify(record)).not.toContain("secret-header");
    expect(JSON.stringify(record)).not.toContain("secret-body");
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });
});
