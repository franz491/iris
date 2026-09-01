import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

type Counts = Record<string, number>;
type Benchmark = { name: string; baseline: Counts; current: Counts; budget: Counts };

function loadBaseline(): { version: number; policy: string; benchmarks: Benchmark[] } {
  const filename = path.resolve(process.cwd(), "../docs/operations/performance-baseline.json");
  return JSON.parse(readFileSync(filename, "utf8")) as { version: number; policy: string; benchmarks: Benchmark[] };
}

describe("published performance baseline contract", () => {
  it("keeps current counts within deterministic budgets and publishes deltas", () => {
    const artifact = loadBaseline();
    expect(artifact.version).toBe(1);
    expect(artifact.policy).toBe("operation-and-data-counts-only");
    expect(artifact.benchmarks.map((benchmark) => benchmark.name)).toEqual([
      "participant-index",
      "prompt-construction",
      "history-query",
      "sse-fanout",
      "tool-loop",
      "compaction",
      "file-transfer",
      "admin-load",
      "startup",
      "tool-doc-cache",
    ]);

    for (const benchmark of artifact.benchmarks) {
      expect(Object.keys(benchmark.current).sort()).toEqual(Object.keys(benchmark.baseline).sort());
      expect(Object.keys(benchmark.current).sort()).toEqual(Object.keys(benchmark.budget).sort());
      for (const key of Object.keys(benchmark.current)) {
        const current = benchmark.current[key];
        const baseline = benchmark.baseline[key];
        const budget = benchmark.budget[key];
        expect(Number.isFinite(current)).toBe(true);
        expect(current).toBeGreaterThanOrEqual(0);
        expect(current).toBeLessThanOrEqual(budget);
        expect(current - baseline).toBe(0);
      }
    }
  });
});
