import { describe, expect, it, vi } from "vitest";
import {
  parseRecoveryRetentionPolicy,
  RecoveryRetentionScheduler,
  startRecoveryRetentionAfterReady,
} from "../src/db/recovery-retention-scheduler.js";
import { metricsSnapshot, resetMetrics } from "../src/misc/metrics.js";
describe("recovery retention scheduler", () => {
  it("records dry-run mode and planned pairs without deletion", async () => {
    resetMetrics();
    const timers: (() => void)[] = [];
    const scheduler = new RecoveryRetentionScheduler(
      { dataRoot: "/tmp/data", tempRoot: "/tmp/temp" },
      { enabled: true, intervalMs: 10, minimumKeep: 1, apply: false, confirmation: "" },
      {
        setTimer: (cb) => {
          timers.push(cb);
          return timers.length as unknown as ReturnType<typeof setTimeout>;
        },
      },
    );
    scheduler.start(() => ({ keep: [], remove: [] }));
    await Promise.resolve();
    const snapshot = metricsSnapshot();
    expect(snapshot.requests["recovery_retention.dry_runs"]).toBe(1);
    expect(snapshot.requests["recovery_retention.pairs_planned"]).toBeUndefined();
    expect(snapshot.requests["recovery_retention.pairs_deleted"]).toBeUndefined();
    expect(snapshot.gauges["recovery_retention.active"]).toBe(0);
    scheduler.stop();
  });
  it("is disabled and non-destructive by default", () => {
    expect(parseRecoveryRetentionPolicy({})).toMatchObject({ enabled: false, apply: false, minimumKeep: 1 });
  });
  it("requires explicit apply confirmation and validates bounds", () => {
    expect(() => parseRecoveryRetentionPolicy({ IRIS_RECOVERY_RETENTION_APPLY: "true" })).toThrow(/confirmation/);
    expect(() => parseRecoveryRetentionPolicy({ IRIS_RECOVERY_RETENTION_INTERVAL_MS: "0" })).toThrow(/interval/);
  });
  it("schedules single-flight work and cancels cleanly", async () => {
    const timers: (() => void)[] = [];
    const run = vi.fn();
    const scheduler = new RecoveryRetentionScheduler(
      { dataRoot: "/tmp/data", tempRoot: "/tmp/temp" },
      { enabled: true, intervalMs: 10, minimumKeep: 1, apply: false, confirmation: "" },
      {
        setTimer: (cb) => {
          timers.push(cb);
          return timers.length as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: vi.fn(),
      },
    );
    run.mockReturnValue({ keep: [], remove: [] });
    scheduler.start(run);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    scheduler.stop();
    expect(timers).toHaveLength(1);
  });
  it("contains retention errors and still schedules the next tick", async () => {
    resetMetrics();
    const timers: (() => void)[] = [],
      errors: unknown[] = [];
    const scheduler = new RecoveryRetentionScheduler(
      { dataRoot: "/tmp/data", tempRoot: "/tmp/temp" },
      { enabled: true, intervalMs: 10, minimumKeep: 1, apply: false, confirmation: "" },
      {
        setTimer: (cb) => {
          timers.push(cb);
          return timers.length as unknown as ReturnType<typeof setTimeout>;
        },
        onError: (e) => errors.push(e),
      },
    );
    scheduler.start(() => {
      throw new Error("retention failed");
    });
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect(timers).toHaveLength(1);
    const snapshot = metricsSnapshot();
    expect(snapshot.requests["recovery_retention.runs_failed"]).toBe(1);
    expect(snapshot.requests["recovery_retention.runs_completed"]).toBeUndefined();
    expect(snapshot.gauges["recovery_retention.active"]).toBe(0);
    expect(snapshot.durationsMs["recovery_retention.duration_ms"].count).toBe(1);
    scheduler.stop();
  });
  it("does not create a scheduler before readiness", () => {
    expect(
      startRecoveryRetentionAfterReady(
        false,
        { dataRoot: "/tmp/data", tempRoot: "/tmp/temp" },
        { enabled: true, intervalMs: 1, minimumKeep: 1, apply: false, confirmation: "" },
      ),
    ).toBeUndefined();
  });
  it("does not run after stop before the first scheduled tick", async () => {
    resetMetrics();
    const timers: (() => void)[] = [];
    const scheduler = new RecoveryRetentionScheduler(
      { dataRoot: "/tmp/fixture", tempRoot: "/tmp/fixture-temp" },
      { enabled: true, intervalMs: 1, minimumKeep: 1, apply: false, confirmation: "" },
      {
        setTimer: (cb) => {
          timers.push(cb);
          return timers.length as unknown as ReturnType<typeof setTimeout>;
        },
      },
    );
    scheduler.stop();
    scheduler.start(() => ({ keep: [], remove: [] }));
    expect(timers).toHaveLength(0);
    expect(metricsSnapshot().requests).toEqual({});
  });
});
