import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("optional measured performance report", () => {
  it("publishes real measurements for every deterministic contract", () => {
    const report = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "../docs/operations/performance-measured-report.json"), "utf8"),
    ) as {
      version: number;
      policy: string;
      measurements: Array<{
        name: string;
        before: Record<string, number>;
        current: Record<string, number>;
        budget: Record<string, number>;
        comparison?: {
          beforeLabel: string;
          currentLabel: string;
          deltaMs: number;
          ratio: number;
          interpretation: "speedup" | "tradeoff";
          firstPage?: {
            beforeLabel: string;
            currentLabel: string;
            deltaMs: number;
            ratio: number;
            interpretation: "speedup" | "tradeoff";
            beforeHeapDeltaBytes?: number;
            currentHeapDeltaBytes?: number;
            heapRatio?: number;
          };
        };
      }>;
    };
    expect(report.version).toBe(1);
    expect(report.policy).toBe("optional-measured-report");
    expect(report.measurements).toHaveLength(10);
    for (const measurement of report.measurements) {
      for (const sample of [measurement.before, measurement.current, measurement.budget]) {
        expect(sample.medianMs).toBeGreaterThan(0);
        expect(sample.p95Ms).toBeGreaterThanOrEqual(sample.medianMs);
        expect(sample.opsPerSecond).toBeGreaterThan(0);
        expect(sample.heapDeltaBytes).toBeGreaterThanOrEqual(0);
      }
      expect(measurement.current.medianMs).toBeLessThanOrEqual(measurement.budget.medianMs);
      expect(measurement.current.p95Ms).toBeLessThanOrEqual(measurement.budget.p95Ms);
    }
    const participant = report.measurements.find((measurement) => measurement.name === "participant-index");
    expect(participant?.comparison).toMatchObject({
      beforeLabel: "linear participant scan",
      currentLabel: "indexed participant lookup",
    });
    expect(participant?.comparison?.ratio).toBeGreaterThan(0);
    expect(participant?.comparison?.interpretation).toBe(participant!.comparison!.ratio >= 1 ? "speedup" : "tradeoff");
    expect(participant?.comparison?.deltaMs).toBe(participant!.before.medianMs - participant!.current.medianMs);
    const history = report.measurements.find((measurement) => measurement.name === "history-query");
    expect(history?.comparison).toMatchObject({
      beforeLabel: "full SQLite history load and in-memory slicing",
      currentLabel: "SQLite LIMIT+1 paginated history",
    });
    expect(history?.comparison?.deltaMs).toBe(history!.before.medianMs - history!.current.medianMs);
    expect(history?.comparison?.firstPage).toMatchObject({
      beforeLabel: "full SQLite load then first page (100-message scope)",
      currentLabel: "SQLite LIMIT+1 first page (100-message scope)",
    });
    expect(history?.comparison?.firstPage?.interpretation).toBe(
      history!.comparison!.firstPage!.ratio >= 1 ? "speedup" : "tradeoff",
    );
    expect(history?.comparison?.firstPage?.beforeHeapDeltaBytes).toBeGreaterThanOrEqual(0);
    expect(history?.comparison?.firstPage?.currentHeapDeltaBytes).toBeGreaterThanOrEqual(0);
  });
});
