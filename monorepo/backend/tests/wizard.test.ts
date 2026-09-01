import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSetupProgress, writeSetupProgress } from "../src/setup/wizard.js";

describe("setup progress file validation", () => {
  const writeProgress = (value: unknown): string => {
    const directory = mkdtempSync(path.join(tmpdir(), "iris-wizard-progress-"));
    const progressPath = path.join(directory, "setup-progress.json");
    writeFileSync(progressPath, JSON.stringify(value));
    return progressPath;
  };

  it.each([0, 1, 2, 3, 4, 5])("preserves valid nextSection %i", (nextSection) => {
    expect(readSetupProgress(writeProgress({ nextSection }))).toBe(nextSection);
  });

  it.each([
    null,
    { nextSection: "2" },
    { nextSection: 1.5 },
    { nextSection: -1 },
    { nextSection: 6 },
    { nextSection: 2, unexpected: true },
  ])("resets invalid progress %j to the first section", (value) => {
    expect(readSetupProgress(writeProgress(value))).toBe(0);
  });

  it("resets missing and malformed progress files", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "iris-wizard-progress-"));
    expect(readSetupProgress(path.join(directory, "missing.json"))).toBe(0);

    const malformedPath = path.join(directory, "malformed.json");
    writeFileSync(malformedPath, "not json");
    expect(readSetupProgress(malformedPath)).toBe(0);
  });

  it("writes valid progress atomically with owner-only permissions", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "iris-wizard-progress-"));
    const progressPath = path.join(directory, "setup-progress.json");

    writeSetupProgress(progressPath, 2);

    expect(JSON.parse(readFileSync(progressPath, "utf8"))).toEqual({ nextSection: 2 });
    if (process.platform !== "win32") expect(statSync(progressPath).mode & 0o777).toBe(0o600);

    chmodSync(progressPath, 0o644);
    writeSetupProgress(progressPath, 3);

    expect(readSetupProgress(progressPath)).toBe(3);
    if (process.platform !== "win32") expect(statSync(progressPath).mode & 0o777).toBe(0o600);
  });
});
