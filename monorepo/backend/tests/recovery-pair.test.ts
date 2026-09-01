import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteBackup,
  discoverRecoveryPairs,
  makeRecoveryPairManifest,
  restoreSqliteBackup,
  revalidateRecoveryPair,
  planRecoveryRetention,
  applyRecoveryRetention,
  type RecoveryPairManifest,
} from "../src/db/recovery.js";

const created: string[] = [];
afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "iris-pair-"));
  const roots = { dataRoot: join(root, "data"), tempRoot: join(root, "temp") };
  mkdirSync(roots.dataRoot);
  mkdirSync(roots.tempRoot);
  created.push(root);
  return { root, roots };
}
async function backupFixture() {
  const { root, roots } = setup();
  const source = join(roots.dataRoot, "source.db");
  const backup = join(roots.dataRoot, "backups", "copy.db");
  const db = new Database(source);
  db.exec("create table values_table (value text); insert into values_table values ('pair-ok')");
  db.close();
  const raw = await createSqliteBackup(source, backup, roots);
  return { root, roots, source, backup, raw, pair: makeRecoveryPairManifest(backup, roots, raw) };
}
async function discovered() {
  const f = await backupFixture();
  const manifestPath = join(f.roots.tempRoot, "pair.json");
  writeFileSync(manifestPath, JSON.stringify(f.pair));
  return { ...f, manifestPath, discovered: discoverRecoveryPairs(f.roots.tempRoot, f.roots)[0] };
}
it("revalidates valid pair", async () => {
  const f = await discovered();
  expect(revalidateRecoveryPair(f.discovered, f.roots).backupPath).toBe(f.backup);
});
it("rejects backup tamper", async () => {
  const f = await discovered();
  writeFileSync(f.backup, "bad");
  expect(() => revalidateRecoveryPair(f.discovered, f.roots)).toThrow();
});
it("rejects manifest mismatch", async () => {
  const f = await discovered();
  writeFileSync(f.manifestPath, JSON.stringify({ ...f.pair, backupPath: "wrong.db" }));
  expect(() => revalidateRecoveryPair(f.discovered, f.roots)).toThrow();
});
it("rejects backup symlink", async () => {
  const f = await discovered();
  const moved = join(f.roots.dataRoot, "moved");
  renameSync(f.backup, moved);
  symlinkSync(moved, f.backup);
  expect(() => revalidateRecoveryPair(f.discovered, f.roots)).toThrow();
});
it("rejects manifest symlink", async () => {
  const f = await discovered();
  const moved = join(f.roots.tempRoot, "moved.json");
  renameSync(f.manifestPath, moved);
  symlinkSync(moved, f.manifestPath);
  expect(() => revalidateRecoveryPair(f.discovered, f.roots)).toThrow();
});

describe("recovery pair manifests", () => {
  it("plans newest valid pairs deterministically and applies exact paths", async () => {
    const f = await discovered();
    const second = join(f.roots.dataRoot, "backups", "second.db");
    const raw = await createSqliteBackup(f.source, second, f.roots);
    const secondManifest = join(f.roots.tempRoot, "second.json");
    writeFileSync(secondManifest, JSON.stringify(makeRecoveryPairManifest(second, f.roots, raw)));
    const plan = planRecoveryRetention(f.roots.tempRoot, f.roots, 1);
    expect(plan.keep).toHaveLength(1);
    expect(plan.remove).toHaveLength(1);
    expect(applyRecoveryRetention(plan, f.roots, true)).toEqual(expect.arrayContaining([f.backup, f.manifestPath]));
    applyRecoveryRetention(plan, f.roots, false);
    expect(existsSync(f.backup)).toBe(false);
    expect(existsSync(f.manifestPath)).toBe(false);
    expect(existsSync(plan.keep[0].backupPath)).toBe(true);
  });

  it("fails closed when a planned pair is tampered after planning", async () => {
    const f = await discovered();
    const plan = planRecoveryRetention(f.roots.tempRoot, f.roots, 1);
    writeFileSync(f.backup, "tampered");
    expect(() => applyRecoveryRetention(plan, f.roots, false)).toThrow();
    expect(existsSync(f.manifestPath)).toBe(true);
  });

  it("round trips a wrapper and accepts a legacy raw v1 manifest", async () => {
    const f = await backupFixture();
    const wrappedTarget = join(f.roots.dataRoot, "wrapped.db");
    restoreSqliteBackup(f.backup, wrappedTarget, f.pair, f.roots, true);
    const wrapped = new Database(wrappedTarget);
    expect(wrapped.prepare("select value from values_table").pluck().get()).toBe("pair-ok");
    wrapped.close();
    const legacyTarget = join(f.roots.dataRoot, "legacy.db");
    restoreSqliteBackup(f.backup, legacyTarget, f.raw, f.roots, true);
    expect(existsSync(legacyTarget)).toBe(true);
  });

  it("rejects a wrapper whose supplied backup path differs", async () => {
    const f = await backupFixture();
    const mismatch: RecoveryPairManifest = { ...f.pair, backupPath: "other.db" };
    expect(() => restoreSqliteBackup(f.backup, join(f.roots.dataRoot, "x.db"), mismatch, f.roots, true)).toThrow(
      /path mismatch/,
    );
    const escaped: RecoveryPairManifest = { ...f.pair, backupPath: "../outside.db" };
    expect(() => restoreSqliteBackup(f.backup, join(f.roots.dataRoot, "y.db"), escaped, f.roots, true)).toThrow();
  });

  it("discovers only validated owned pairs and leaves temp files untouched", async () => {
    const f = await backupFixture();
    const validPath = join(f.roots.tempRoot, "nested", "valid.json");
    mkdirSync(join(f.roots.tempRoot, "nested"));
    writeFileSync(validPath, JSON.stringify(f.pair), { mode: 0o600 });
    writeFileSync(join(f.roots.tempRoot, "unrelated.json"), JSON.stringify({ hello: "world" }));
    writeFileSync(join(f.roots.tempRoot, "malformed.json"), "not json");
    const badDigest = { ...f.pair, manifest: { ...f.pair.manifest, sha256: "0".repeat(64) } };
    writeFileSync(join(f.roots.tempRoot, "bad-digest.json"), JSON.stringify(badDigest));
    const outside = join(f.root, "outside.json");
    writeFileSync(outside, JSON.stringify(f.pair));
    symlinkSync(outside, join(f.roots.tempRoot, "final-link.json"));
    mkdirSync(join(f.root, "link-dir"));
    writeFileSync(join(f.root, "link-dir", "nested.json"), JSON.stringify(f.pair));
    symlinkSync(join(f.root, "link-dir"), join(f.roots.tempRoot, "intermediate-link"));

    const before = readFileSync(validPath, "utf8");
    expect(discoverRecoveryPairs(f.roots.tempRoot, f.roots)).toEqual([
      { manifestPath: validPath, backupPath: f.backup, manifest: f.pair },
    ]);
    expect(readFileSync(validPath, "utf8")).toBe(before);
    expect(existsSync(join(f.roots.tempRoot, "final-link.json"))).toBe(true);
  });
});
