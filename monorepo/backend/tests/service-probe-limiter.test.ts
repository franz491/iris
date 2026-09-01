import { beforeEach, describe, expect, it } from "vitest";
import {
  resetServiceProbeLimiter,
  serviceProbeLimiter,
  SERVICE_PROBE_LIMIT_PER_WINDOW,
  serviceProbeRateLimitResponse,
} from "../src/api/service-probe-limiter.js";

beforeEach(resetServiceProbeLimiter);

describe("service probe limiter", () => {
  it("limits each account and trusted source atomically", () => {
    const keys = ["account:admin", "source:198.51.100.4"];
    for (let i = 0; i < SERVICE_PROBE_LIMIT_PER_WINDOW; i++)
      expect(serviceProbeLimiter.consume(keys, 1000 + i)).toBeUndefined();
    expect(serviceProbeLimiter.consume(keys, 2000)).toBe(59);
    expect(serviceProbeLimiter.consume(["account:other", "source:198.51.100.4"], 2000)).toBe(59);
    expect(serviceProbeLimiter.consume(["account:other", "source:203.0.113.5"], 2000)).toBeUndefined();
  });

  it("expires windows and returns a cache-safe response", async () => {
    for (let i = 0; i < SERVICE_PROBE_LIMIT_PER_WINDOW; i++) serviceProbeLimiter.consume(["account:admin"], 1000 + i);
    expect(serviceProbeLimiter.consume(["account:admin"], 61_001)).toBeUndefined();
    const response = serviceProbeRateLimitResponse(7);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    await expect(response.json()).resolves.toEqual({
      error: "rate_limited",
      message: "Too many service probes; try again later.",
    });
  });
});
