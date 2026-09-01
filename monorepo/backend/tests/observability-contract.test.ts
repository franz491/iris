import { describe, expect, it } from "vitest";
import { createSupportBundle } from "../src/misc/support-bundle.js";
import {
  metricsSnapshot,
  resetMetrics,
  recordDbOperation,
  recordRequest,
  setGauge,
  increment,
} from "../src/misc/metrics.js";
describe("observability contract", () => {
  it("keeps fixed metrics finite, bounded, and deterministic", () => {
    resetMetrics();
    recordRequest("GET", 200, 5);
    recordDbOperation(7, true);
    increment("generations.started");
    setGauge("sse.active_clients", 2);
    setGauge("cache.bytes", 4);
    const a = metricsSnapshot();
    const b = metricsSnapshot();
    expect(a).toEqual(b);
    for (const [name, value] of Object.entries(a.requests as Record<string, number>)) {
      expect(name).toMatch(/^[a-zA-Z0-9_.-]+$/);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    for (const group of [a.durationsMs, a.gauges] as Record<string, unknown>[])
      for (const value of Object.values(group))
        expect(JSON.stringify(value)).not.toMatch(/secret|password|token|cookie|\/tmp/);
  });
  it("keeps support bundles bounded and secret-free across registered metrics", () => {
    const out = createSupportBundle({
      version: "1",
      readiness: "ready",
      metrics: metricsSnapshot(),
      configSummary: { apiKey: "secret", path: "/tmp/private" },
      audit: [{ token: "tok", password: "pw", cookie: "sess" }],
    });
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(256 * 1024);
    expect(out).not.toContain("secret");
    expect(out).not.toContain("/tmp/private");
    expect(out).not.toContain('"tok"');
    expect(out).not.toContain('"pw"');
    expect(out).not.toContain('"sess"');
  });
});
