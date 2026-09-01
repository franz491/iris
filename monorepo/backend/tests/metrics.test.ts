import { describe, expect, it, beforeEach } from "vitest";
import { health } from "../src/api/health.js";
import { metricsSnapshot, recordDbOperation, recordRequest, resetMetrics } from "../src/misc/metrics.js";
describe("bounded metrics", () => {
  beforeEach(resetMetrics);
  it("records only method/status classes and bounded durations", async () => {
    recordRequest("GET", 200, 12);
    const out = await (await health.request("/metrics")).json();
    expect(out.requests.GET).toBeUndefined();
    expect(out.requests["GET.2xx"]).toBe(1);
    expect(out.durationsMs["GET.2xx"].count).toBe(1);
  });
  it("normalizes malformed status, method, and duration values", async () => {
    recordRequest("bad method with spaces", Number.NaN, Number.POSITIVE_INFINITY);
    const out = await (await health.request("/metrics")).json();
    expect(out.requests["OTHER.5xx"]).toBe(1);
    expect(out.durationsMs["OTHER.5xx"].total).toBe(0);
  });
  it("records one bounded DB duration and failure count per operation", () => {
    recordDbOperation(12);
    recordDbOperation(Number.POSITIVE_INFINITY, true);
    const snapshot = metricsSnapshot();
    expect(snapshot.durationsMs["db.operation"]).toEqual({ total: 12, count: 2 });
    expect(snapshot.requests["db.failure"]).toBe(1);
  });
});
