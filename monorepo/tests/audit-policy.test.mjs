import assert from "node:assert/strict";
import test from "node:test";
import { blockingFindings, loadAuditPolicy, parseAuditOutput } from "../scripts/audit-policy.mjs";

const base = { enabled: true, productionSeverity: "high", developmentSeverity: "critical", exceptions: [] };
test("audit policy rejects disabled and malformed or expired exceptions", () => {
  assert.throws(() => loadAuditPolicy(JSON.stringify({ ...base, enabled: false })));
  assert.throws(() => loadAuditPolicy(JSON.stringify({ ...base, exceptions: [{ package: "x" }] })));
  assert.throws(() =>
    loadAuditPolicy(
      JSON.stringify({
        ...base,
        exceptions: [{ package: "x", severity: "high", scope: "all", owner: "a", reason: "r", expires: "2020-01-01" }],
      }),
    ),
  );
  assert.throws(() =>
    loadAuditPolicy(
      JSON.stringify({
        ...base,
        exceptions: [{ package: "x", severity: "high", scope: "all", owner: "a", reason: "r", expires: "2999-02-31" }],
      }),
    ),
  );
});

test("exceptions are scoped and do not suppress higher severity findings", () => {
  const policy = loadAuditPolicy(
    JSON.stringify({
      ...base,
      exceptions: [
        {
          package: "dev-only",
          severity: "critical",
          scope: "development",
          owner: "security",
          reason: "upgrade queued",
          expires: "2999-01-01",
        },
      ],
    }),
  );
  assert.deepEqual(
    blockingFindings(
      [
        { package: "prod", severity: "high" },
        { package: "dev-only", severity: "critical" },
      ],
      policy,
      "production",
    ),
    [
      { package: "prod", severity: "high" },
      { package: "dev-only", severity: "critical" },
    ],
  );
  assert.deepEqual(blockingFindings([{ package: "dev-only", severity: "critical" }], policy, "development"), []);
});

test("parses pnpm legacy and modern reports and rejects malformed findings", () => {
  assert.deepEqual(
    parseAuditOutput(JSON.stringify({ advisories: { one: { module_name: "legacy", severity: "high" } } })),
    [{ package: "legacy", severity: "high" }],
  );
  assert.deepEqual(parseAuditOutput(JSON.stringify({ vulnerabilities: { modern: { severity: "critical" } } })), [
    { package: "modern", severity: "critical" },
  ]);
  assert.deepEqual(parseAuditOutput(JSON.stringify({ metadata: { vulnerabilities: 0 } })), []);
  assert.throws(() => parseAuditOutput(JSON.stringify({ vulnerabilities: { bad: {} } })));
  assert.throws(() => parseAuditOutput(JSON.stringify({ unexpected: true })));
  assert.throws(() => parseAuditOutput("registry unavailable"));
});
