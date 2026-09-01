import { beforeEach, describe, expect, it } from "vitest";
import { health, setReadiness } from "../src/api/health.js";

describe("health endpoints", () => {
  beforeEach(() => setReadiness("starting"));
  it("keeps liveness minimal and readiness unavailable until startup completes", async () => {
    expect((await health.request("/health")).status).toBe(200);
    expect(await (await health.request("/health")).json()).toEqual({ status: "ok" });
    const pending = await health.request("/ready");
    expect(pending.status).toBe(503);
    expect(await pending.json()).toEqual({ status: "not_ready" });
    setReadiness("ready");
    expect((await health.request("/ready")).status).toBe(200);
  });
  it("reports failed and shutting-down states as unavailable", async () => {
    for (const state of ["failed", "shutting_down"] as const) {
      setReadiness(state);
      expect((await health.request("/ready")).status).toBe(503);
    }
  });
});
