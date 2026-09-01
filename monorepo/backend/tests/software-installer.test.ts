import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { requireHashLockedRequirements, runManaged, validOwnership, prepareManaged } from "../src/admin/software.js";

describe("managed installer safety helpers", () => {
  it("requires an exact ownership manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "iris-installer-"));
    const source = "https://github.com/example/project";
    const revision = "a".repeat(40);
    writeFileSync(
      join(root, ".iris-managed.json"),
      JSON.stringify({ owner: "iris-managed-installer-v1", source, revision, createdAt: new Date().toISOString() }),
    );
    expect(validOwnership(root, source, revision)).toBe(true);
    expect(validOwnership(root, source, "b".repeat(40))).toBe(false);
    expect(validOwnership(root, "https://github.com/other/project", revision)).toBe(false);
  });

  it("refuses to modify a symlinked managed installation", async () => {
    const root = join(tmpdir(), "iris-symlink-final");
    await expect(
      prepareManaged(
        root,
        "source",
        "a".repeat(40),
        () => {},
        {},
        {
          exists: (path) => path === root,
          isSymlink: () => true,
          mkdir: () => {},
        },
      ),
    ).rejects.toThrow(/symlinked/);
  });

  it("refuses a managed installation below a symlinked parent", async () => {
    const root = join(tmpdir(), "iris-symlink-parent", "nested");
    await expect(
      prepareManaged(
        root,
        "source",
        "a".repeat(40),
        () => {},
        {},
        {
          exists: (path) => path === root || path.endsWith("iris-symlink-parent"),
          isSymlink: (path) => path.endsWith("iris-symlink-parent"),
          mkdir: () => {},
        },
      ),
    ).rejects.toThrow(/symlinked/);
  });

  it("fails clearly when dependency hashes are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "iris-installer-"));
    writeFileSync(join(root, "requirements.txt"), "requests==2.0\n");
    expect(() => requireHashLockedRequirements(root)).toThrow(/sha256 hashes/i);
    writeFileSync(join(root, "requirements.txt"), "requests==2.0 --hash=sha256:" + "a".repeat(64) + "\n");
    expect(() => requireHashLockedRequirements(root)).not.toThrow();
  });

  it("cancels a child process and bounds emitted output", async () => {
    const controller = new AbortController();
    const logs: string[] = [];
    const command = runManaged(
      process.execPath,
      ["-e", "setInterval(() => console.log('x'.repeat(10000)), 1)"],
      undefined,
      (text) => logs.push(text),
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 25);
    await expect(command).rejects.toThrow();
    expect(logs.join("").length).toBeLessThan(100000);
  });

  it("promotes a verified staged checkout atomically", async () => {
    const parent = mkdtempSync(join(tmpdir(), "iris-stage-"));
    const root = join(parent, "final");
    const stage = join(parent, "stage");
    const revision = "a".repeat(40);
    const calls: string[] = [];
    await prepareManaged(
      root,
      "source",
      revision,
      () => {},
      {},
      {
        stage: () => stage,
        exists: (p) => p === stage || p.endsWith("/.git"),
        mkdir: () => {},
        run: async () => {},
        head: () => revision,
        rename: (a, b) => {
          calls.push(`${a}->${b}`);
          mkdirSync(b, { recursive: true });
          writeFileSync(
            join(b, ".iris-managed.json"),
            JSON.stringify({
              owner: "iris-managed-installer-v1",
              source: "source",
              revision,
              createdAt: new Date().toISOString(),
            }),
          );
        },
        remove: () => {},
      },
    );
    expect(calls).toEqual([`${stage}->${root}`]);
  });

  it("cleans staged checkout on HEAD mismatch", async () => {
    const root = join(tmpdir(), "iris-mismatch-final");
    const stage = root + ".stage";
    let removed = "";
    await expect(
      prepareManaged(
        root,
        "source",
        "a".repeat(40),
        () => {},
        {},
        {
          stage: () => stage,
          exists: (p) => p === stage || p.endsWith("/.git"),
          mkdir: () => {},
          run: async () => {},
          head: () => "b".repeat(40),
          rename: () => {},
          remove: (p) => {
            removed = p;
          },
        },
      ),
    ).rejects.toThrow(/HEAD/);
    expect(removed).toBe(stage);
  });

  it("cleans staged checkout on command failure", async () => {
    const root = join(tmpdir(), "iris-failure-final");
    const stage = root + ".stage";
    let removed = "";
    await expect(
      prepareManaged(
        root,
        "source",
        "a".repeat(40),
        () => {},
        {},
        {
          stage: () => stage,
          exists: (p) => p === stage || p.endsWith("/.git"),
          mkdir: () => {},
          run: async () => {
            throw new Error("failed");
          },
          head: () => "a".repeat(40),
          rename: () => {},
          remove: (p) => {
            removed = p;
          },
        },
      ),
    ).rejects.toThrow(/failed/);
    expect(removed).toBe(stage);
  });

  it("preserves a destination that appears during staging", async () => {
    const root = join(tmpdir(), "iris-race-final");
    const stage = root + ".stage";
    let removed = "";
    let checks = 0;
    await expect(
      prepareManaged(
        root,
        "source",
        "a".repeat(40),
        () => {},
        {},
        {
          stage: () => stage,
          exists: (p) => p === stage || p.endsWith("/.git") || (p === root && ++checks > 1),
          mkdir: () => {},
          run: async () => {},
          head: () => "a".repeat(40),
          rename: () => {},
          remove: (p) => {
            removed = p;
          },
        },
      ),
    ).rejects.toThrow(/appeared/);
    expect(removed).toBe(stage);
  });
});
