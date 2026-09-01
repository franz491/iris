import { readFileSync } from "node:fs";
const workflow = readFileSync(new URL("../../.github/workflows/verify.yml", import.meta.url), "utf8");
const dependabot = readFileSync(new URL("../../.github/dependabot.yml", import.meta.url), "utf8");
const dependencyPolicy = JSON.parse(
  readFileSync(new URL("../../.github/dependency-policy.json", import.meta.url), "utf8"),
);
const coveragePolicy = JSON.parse(readFileSync(new URL("../coverage-policy.json", import.meta.url), "utf8"));
for (const required of [
  "permissions:\n  contents: read",
  'node-version: "22.13.0"',
  "version: 11.22.0",
  "pnpm install --frozen-lockfile",
  "run: pnpm verify",
  "run: pnpm clean:check",
]) {
  if (!workflow.includes(required)) throw new Error(`CI workflow missing: ${required}`);
}
if (/pull_request_target|contents:\s*write|secrets\./.test(workflow))
  throw new Error("CI workflow has unsafe permissions or secret access");
if (!/^version:\s*2\s*$/m.test(dependabot)) throw new Error("Dependabot config missing version 2");
if ((dependabot.match(/package-ecosystem:/g) ?? []).length !== 2)
  throw new Error("Dependabot must configure exactly npm and Cargo");
if (!/package-ecosystem:\s*npm[\s\S]*directory:\s*\/monorepo[\s\S]*interval:\s*monthly/.test(dependabot))
  throw new Error("Dependabot npm schedule or directory invalid");
if (
  !/package-ecosystem:\s*cargo[\s\S]*directory:\s*\/monorepo\/frontend\/src-tauri[\s\S]*interval:\s*monthly/.test(
    dependabot,
  )
)
  throw new Error("Dependabot Cargo schedule or directory invalid");
if ((dependabot.match(/open-pull-requests-limit:\s*5/g) ?? []).length !== 2 || !/groups:/.test(dependabot))
  throw new Error("Dependabot limits/groups missing");
if (/automerge|auto-merge|secrets\.|contents:\s*write/i.test(dependabot))
  throw new Error("Dependabot config enables unsafe automation");
if (
  dependencyPolicy.cadence !== "monthly" ||
  dependencyPolicy.lockfile !== "pnpm-lock.yaml" ||
  dependencyPolicy.frozenInstallRequired !== true ||
  dependencyPolicy.automatedMajorUpdates !== false ||
  dependencyPolicy.reviewRequired !== true
)
  throw new Error("dependency update policy is unsafe or incomplete");
const vitest = readFileSync(new URL("../backend/vitest.config.ts", import.meta.url), "utf8");
for (const module of coveragePolicy.criticalModules)
  if (!vitest.includes(`"${module}"`)) throw new Error(`coverage module missing: ${module}`);
for (const [metric, minimum] of Object.entries(coveragePolicy.thresholds)) {
  const configured = new RegExp(`${metric}:\\s*(\\d+)`).exec(vitest)?.[1];
  if (!configured || Number(configured) < minimum) throw new Error(`coverage threshold decreased: ${metric}`);
}
if (coveragePolicy.ratchet !== "non-decreasing") throw new Error("coverage ratchet policy missing");
console.log("CI workflow check passed.");
