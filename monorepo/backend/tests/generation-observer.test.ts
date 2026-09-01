import { describe, expect, it } from "vitest";
import { observeGeneration } from "../src/misc/generation-observer.js";
import { metricsSnapshot, resetMetrics } from "../src/misc/metrics.js";
describe("generation observer", () => {
  it("emits deterministic allowlisted success events and balances gauge", async () => {
    resetMetrics();
    const events: any[] = [];
    await observeGeneration(
      async () => {},
      (e) => events.push(e),
      { id: () => "g-1", now: () => "t" },
    );
    expect(events).toEqual([
      { event: "started", generationId: "g-1", timestamp: "t" },
      { event: "completed", generationId: "g-1", timestamp: "t" },
    ]);
    expect(metricsSnapshot().gauges).toEqual({ "generations.active": 0 });
  });
  it("records failure, rethrows, and balances gauge", async () => {
    resetMetrics();
    const events: any[] = [];
    await expect(
      observeGeneration(
        async () => {
          throw new Error("x");
        },
        (e) => events.push(e),
        { id: () => "g-2", now: () => "t" },
      ),
    ).rejects.toThrow("x");
    expect(events[1].event).toBe("failed");
    expect(metricsSnapshot().gauges).toEqual({ "generations.active": 0 });
  });
  it("records a normally-resolving abort as cancelled exactly once", async () => {
    resetMetrics();
    const events: any[] = [];
    const controller = new AbortController();
    let release!: () => void;
    const run = observeGeneration(
      () => new Promise<void>((resolve) => (release = resolve)),
      (e) => events.push(e),
      {
        id: () => "g-cancelled",
        now: () => "t",
        isCancelled: () => controller.signal.aborted,
      },
    );
    controller.abort();
    release();
    await run;
    expect(events.map((event) => event.event)).toEqual(["started", "cancelled"]);
    expect(metricsSnapshot().requests).toMatchObject({
      "generations.started": 1,
      "generations.cancelled": 1,
    });
    expect(metricsSnapshot().requests["generations.completed"]).toBeUndefined();
    expect(metricsSnapshot().gauges).toEqual({ "generations.active": 0 });
  });
  it("peaks at two for concurrent runs and returns to zero", async () => {
    resetMetrics();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const a = observeGeneration(() => gate, undefined, { id: () => "a" });
    const b = observeGeneration(() => gate, undefined, { id: () => "b" });
    await Promise.resolve();
    expect(metricsSnapshot().gauges).toEqual({ "generations.active": 2 });
    release();
    await Promise.all([a, b]);
    expect(metricsSnapshot().gauges).toEqual({ "generations.active": 0 });
  });
  it("tracks concurrent generations independently", async () => {
    resetMetrics();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const deferred = () =>
      new Promise<void>((resolve) => {
        if (!releaseA) releaseA = resolve;
        else releaseB = resolve;
      });
    const events: Record<string, string[]> = {};
    const a = observeGeneration(
      deferred,
      (e) => {
        (events[e.generationId] ??= []).push(e.event);
      },
      { id: () => "a", now: () => "t" },
    );
    const b = observeGeneration(
      deferred,
      (e) => {
        (events[e.generationId] ??= []).push(e.event);
      },
      { id: () => "b", now: () => "t" },
    );
    expect(metricsSnapshot().gauges["generations.active"]).toBe(2);
    releaseA();
    await a;
    expect(metricsSnapshot().gauges["generations.active"]).toBe(1);
    releaseB();
    await b;
    expect(metricsSnapshot().gauges["generations.active"]).toBe(0);
    expect(events).toEqual({ a: ["started", "completed"], b: ["started", "completed"] });
  });
});
