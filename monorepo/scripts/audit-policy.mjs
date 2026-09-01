import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const severities = ["low", "moderate", "high", "critical"];
const exceptionScopes = new Set(["production", "development", "all"]);

export function loadAuditPolicy(
  text = readFileSync(new URL("../audit-policy.json", import.meta.url), "utf8"),
  now = new Date(),
) {
  const policy = JSON.parse(text);
  if (policy?.enabled !== true) throw new Error("audit policy must be enabled");
  for (const key of ["productionSeverity", "developmentSeverity"])
    if (!severities.includes(policy[key])) throw new Error(`invalid audit policy ${key}`);
  if (!Array.isArray(policy.exceptions)) throw new Error("audit policy exceptions must be an array");
  const exceptions = policy.exceptions.map((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.package !== "string" || !entry.package)
      throw new Error("audit exception requires package");
    if (!severities.includes(entry.severity)) throw new Error("audit exception has invalid severity");
    if (!exceptionScopes.has(entry.scope)) throw new Error("audit exception has invalid scope");
    if (
      typeof entry.owner !== "string" ||
      !entry.owner.trim() ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim()
    )
      throw new Error("audit exception requires owner and reason");
    const expiry = typeof entry.expires === "string" ? new Date(`${entry.expires}T00:00:00Z`) : new Date(NaN);
    if (
      typeof entry.expires !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires) ||
      Number.isNaN(expiry.getTime()) ||
      expiry.toISOString().slice(0, 10) !== entry.expires ||
      expiry <= now
    )
      throw new Error("audit exception is expired or has an invalid expiry");
    return entry;
  });
  return { ...policy, exceptions };
}

export function blockingFindings(findings, policy, scope) {
  const threshold = severities.indexOf(policy[scope === "production" ? "productionSeverity" : "developmentSeverity"]);
  return findings.filter((finding) => {
    if (!finding || typeof finding.package !== "string" || !severities.includes(finding.severity))
      throw new Error("dependency audit returned a malformed finding");
    if (severities.indexOf(finding.severity) < threshold) return false;
    return !policy.exceptions.some(
      (entry) =>
        entry.package === finding.package &&
        (entry.scope === "all" || entry.scope === scope) &&
        severities.indexOf(entry.severity) >= severities.indexOf(finding.severity),
    );
  });
}

export function parseAuditOutput(output) {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("dependency audit returned no JSON (network or registry failure)");
  const report = JSON.parse(output.slice(start));
  let findings;
  if (report.vulnerabilities && typeof report.vulnerabilities === "object")
    findings = Object.entries(report.vulnerabilities).map(([pkg, value]) => ({
      package: pkg,
      severity: value?.severity,
    }));
  else if (report.advisories && typeof report.advisories === "object")
    findings = Object.values(report.advisories).map((value) => ({
      package: value?.module_name,
      severity: value?.severity,
    }));
  else if (report.metadata && typeof report.metadata === "object") findings = [];
  else throw new Error("dependency audit returned an unsupported JSON report");
  for (const finding of findings)
    if (typeof finding.package !== "string" || !finding.package || !severities.includes(finding.severity))
      throw new Error("dependency audit returned a malformed finding");
  return findings;
}

function run(scope, production) {
  const args = ["audit", "--json", "--audit-level", "low", ...(production ? ["--prod"] : [])];
  const result = spawnSync("pnpm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (result.error) throw new Error(`dependency audit failed: ${result.error.message}`);
  const findings = parseAuditOutput(result.stdout ?? "");
  const blocked = blockingFindings(findings, policy, scope);
  if (blocked.length) throw new Error(`${scope} dependency audit blocked ${blocked.length} vulnerability(ies)`);
}

const policy = loadAuditPolicy();
if (import.meta.main) {
  run("production", true);
  run("development", false);
  console.log("Dependency audit policy passed.");
}
