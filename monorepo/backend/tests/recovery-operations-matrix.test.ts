import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd());
const runbook = readFileSync(path.join(root, "../docs/operations/RECOVERY_MIGRATION_RUNBOOK.md"), "utf8");
const procedures = [
  ["API-key master-key rotation", "tests/encrypted-keys.test.ts", /rotates every row/],
  [
    "Migration, corrupt database, lost administrator, and stuck lock",
    "tests/migration-status-cli.test.ts",
    /malformed args/,
  ],
  ["Disk-full and broken managed service", "tests/admin-services.test.ts", /owned process|service/],
  ["Cache purge and logs/support bundle", "tests/support-bundle.test.ts", /support bundle/],
  ["Rollback and verification checklist", "tests/admin-control-plane.test.ts", /rollback/],
  ["Retention (operator-confirmed)", "tests/recovery-retention-drill.test.ts", /offline recovery retention drill/],
] as const;

describe("documented recovery operation evidence", () => {
  it.each(procedures)("maps %s to an executable focused test", (heading, testFile, evidence) => {
    expect(runbook).toContain(heading);
    expect(existsSync(path.join(root, testFile))).toBe(true);
    expect(readFileSync(path.join(root, testFile), "utf8")).toMatch(evidence);
  });
});
