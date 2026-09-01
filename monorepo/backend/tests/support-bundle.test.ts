import { describe, expect, it } from "vitest";
import { createSupportBundle } from "../src/misc/support-bundle.js";
describe("support bundle", () => {
  it("exports only bounded redacted diagnostics", () => {
    const out = createSupportBundle({
      version: "1",
      readiness: "ready",
      metrics: { requests: {} },
      configSummary: { apiKey: "secret", path: "/private" },
      audit: [{ password: "pw", token: "tok", cookie: "sess" }],
    });
    expect(out).toContain('"format": "iris.support-bundle"');
    expect(out).not.toMatch(/secret|password.*pw|token.*tok|sess|\/private/);
  });
});
