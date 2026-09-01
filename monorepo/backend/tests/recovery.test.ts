import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSqliteBackup, restoreSqliteBackup } from "../src/db/recovery.js";

const created: string[] = [];
afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});
const roots = () => {
  const base = mkdtempSync(join(tmpdir(), "iris-recovery-"));
  const result = { dataRoot: join(base, "data"), tempRoot: join(base, "tmp") };
  created.push(base);
  mkdirSync(result.dataRoot, { recursive: true });
  mkdirSync(result.tempRoot, { recursive: true });
  return result;
};
describe("SQLite recovery", () => {
  it("fails closed on ENOSPC during promotion", async () => {
    const r = roots(),
      source = join(r.dataRoot, "source.db"),
      backup = join(r.dataRoot, "backup.db");
    const db = new Database(source);
    db.exec("create table t(v); insert into t values ('source')");
    db.close();
    const before = readFileSync(source);
    const fs = {
      exists: existsSync,
      mkdir: (p: string, o?: any) => mkdirSync(p, o),
      chmod: chmodSync,
      link: () => {
        const e = new Error("disk full");
        (e as any).code = "ENOSPC";
        throw e;
      },
      unlink: unlinkSync,
      write: writeFileSync,
    };
    await expect(createSqliteBackup(source, backup, r, fs)).rejects.toThrow("disk full");
    expect(readFileSync(source)).toEqual(before);
    expect(existsSync(backup)).toBe(false);
    expect(readdirSync(r.dataRoot).filter((x) => x.startsWith(".iris-backup-")).length).toBe(0);
  });
  it("round trips uncheckpointed WAL data", async () => {
    const r = roots(),
      source = join(r.dataRoot, "source.db"),
      backup = join(r.dataRoot, "backup.db"),
      target = join(r.dataRoot, "target.db");
    const db = new Database(source);
    db.pragma("journal_mode=WAL");
    db.exec("create table t (v text); insert into t values ('wal-value')");
    const manifest = await createSqliteBackup(source, backup, r);
    db.close();
    restoreSqliteBackup(backup, target, manifest, r, true);
    const restored = new Database(target);
    expect(restored.prepare("select v from t").pluck().get()).toBe("wal-value");
    restored.close();
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
  });
  it("rejects hash mismatch and preserves destination", async () => {
    const r = roots(),
      source = join(r.dataRoot, "s.db"),
      backup = join(r.dataRoot, "b.db"),
      target = join(r.dataRoot, "t.db");
    const db = new Database(source);
    db.exec("create table t(v); insert into t values(1)");
    db.close();
    const m = await createSqliteBackup(source, backup, r);
    writeFileSync(target, Buffer.from("keep"));
    writeFileSync(backup, Buffer.from("bad"));
    expect(() => restoreSqliteBackup(backup, target, m, r, true)).toThrow(/manifest/);
    expect(readFileSync(target, "utf8")).toBe("keep");
  });
  it("rejects escapes and symlink paths", async () => {
    const r = roots();
    expect(() =>
      restoreSqliteBackup(
        join(tmpdir(), "x"),
        join(r.dataRoot, "x"),
        { version: 1, sha256: "", bytes: 0, createdAt: "" },
        r,
        true,
      ),
    ).toThrow();
    const source = join(r.dataRoot, "s.db"),
      outside = join(dirname(r.dataRoot), "outside.db");
    writeFileSync(outside, "x");
    symlinkSync(outside, source);
    await expect(createSqliteBackup(source, join(r.dataRoot, "b.db"), r)).rejects.toThrow(/symbolic/);
  });
  it("rejects restore through a symlinked backup directory", async () => {
    const r = roots();
    const source = join(r.dataRoot, "s.db"),
      backup = join(r.dataRoot, "b.db"),
      target = join(r.dataRoot, "t.db");
    const db = new Database(source);
    db.exec("create table t(v); insert into t values (1)");
    db.close();
    const manifest = await createSqliteBackup(source, backup, r);
    const outside = join(dirname(r.dataRoot), "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(r.tempRoot, "redirect"));
    expect(() => restoreSqliteBackup(join(r.tempRoot, "redirect", "b.db"), target, manifest, r, true)).toThrow(
      /symlinked components/,
    );
  });
  it("uses owner-only permissions and refuses existing destination", async () => {
    if (process.platform === "win32") return;
    const r = roots(),
      s = join(r.dataRoot, "s.db"),
      b = join(r.dataRoot, "b.db");
    const db = new Database(s);
    db.exec("create table t(v)");
    db.close();
    const m = await createSqliteBackup(s, b, r);
    expect(statSync(b).mode & 0o777).toBe(0o600);
    await expect(createSqliteBackup(s, b, r)).rejects.toThrow();
    expect(m.bytes).toBeGreaterThan(0);
  });
  it("rejects intermediate symlink components", async () => {
    const r = roots(),
      outside = mkdtempSync(join(tmpdir(), "iris-out-"));
    created.push(outside);
    symlinkSync(outside, join(r.dataRoot, "escape"));
    await expect(createSqliteBackup(join(r.dataRoot, "escape", "s.db"), join(r.dataRoot, "b.db"), r)).rejects.toThrow();
    await expect(createSqliteBackup(join(r.dataRoot, "s.db"), join(r.dataRoot, "escape", "b.db"), r)).rejects.toThrow();
  });
  it("bounds a busy-lock failure and succeeds after the owner releases it", () => {
    const r = roots();
    const file = join(r.dataRoot, "busy.db");
    const owner = new Database(file);
    owner.exec("create table t(v integer); insert into t values (1)");
    owner.exec("BEGIN EXCLUSIVE");
    const contender = new Database(file, { timeout: 25 });
    try {
      expect(() => contender.prepare("insert into t values (2)").run()).toThrow(/busy|locked/i);
      owner.exec("ROLLBACK");
      expect(() => contender.prepare("insert into t values (2)").run()).not.toThrow();
      expect(contender.prepare("select count(*) from t").pluck().get()).toBe(2);
    } finally {
      contender.close();
      owner.close();
    }
  });
});
