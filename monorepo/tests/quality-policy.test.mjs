import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("coverage policy matches critical Vitest gate and cannot ratchet down", () => {
  const policy = JSON.parse(readFileSync(new URL("../coverage-policy.json", import.meta.url)));
  const vitest = readFileSync(new URL("../backend/vitest.config.ts", import.meta.url), "utf8");
  assert.equal(policy.ratchet, "non-decreasing");
  for (const module of policy.criticalModules)
    assert.match(vitest, new RegExp(module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const [metric, threshold] of Object.entries(policy.thresholds))
    assert.ok(Number(new RegExp(`${metric}:\\s*(\\d+)`).exec(vitest)?.[1]) >= threshold);
});

test("dependency update policy requires review and frozen lockfiles", () => {
  const policy = JSON.parse(readFileSync(new URL("../../.github/dependency-policy.json", import.meta.url)));
  assert.deepEqual(policy, {
    cadence: "monthly",
    lockfile: "pnpm-lock.yaml",
    frozenInstallRequired: true,
    automatedMajorUpdates: false,
    reviewRequired: true,
    emergencySecurityUpdates: "maintainer-reviewed expedited update with full verification",
  });
});
