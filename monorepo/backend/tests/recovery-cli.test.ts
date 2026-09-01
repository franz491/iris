import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecoveryCommand } from "../src/cli/recovery.js";
import { createSqliteBackup, makeRecoveryPairManifest } from "../src/db/recovery.js";
describe("recovery command", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  it("round trips and rejects unsafe invocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "iris-cli-")),
      dataRoot = join(root, "data"),
      tempRoot = join(root, "temp");
    created.push(root);
    mkdirSync(dataRoot);
    mkdirSync(tempRoot);
    const source = join(dataRoot, "s.db"),
      backup = join(dataRoot, "b.db"),
      target = join(dataRoot, "t.db"),
      manifest = join(tempRoot, "m.json");
    const db = new Database(source);
    db.exec("create table t(v); insert into t values ('ok')");
    db.close();
    const env = {
      IRIS_DATA_DIR: dataRoot,
      IRIS_RECOVERY_CONFIRM: "CLOSED_HANDLES",
    };
    const out: string[] = [];
    await runRecoveryCommand(["recovery", "backup", tempRoot, source, backup, manifest], env, (x) => out.push(x));
    const m = JSON.parse(out[0]);
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toEqual(m);
    if (process.platform !== "win32") expect(statSync(manifest).mode & 0o777).toBe(0o600);
    await runRecoveryCommand(["recovery", "restore", tempRoot, backup, target, manifest], env, (value) =>
      out.push(value),
    );
    const restored = new Database(target);
    expect(restored.prepare("select v from t").pluck().get()).toBe("ok");
    restored.close();
    const preserved = "keep";
    writeFileSync(manifest, preserved);
    await expect(
      runRecoveryCommand(["recovery", "backup", tempRoot, source, join(dataRoot, "new.db"), manifest], env),
    ).rejects.toThrow();
    expect(readFileSync(manifest, "utf8")).toBe(preserved);
    const failedBackup = join(dataRoot, "failed.db"),
      failedManifest = join(tempRoot, "missing", "m.json");
    await expect(
      runRecoveryCommand(["recovery", "backup", tempRoot, source, failedBackup, failedManifest], env),
    ).rejects.toThrow();
    expect(() => statSync(failedBackup)).toThrow();
    const outside = join(root, "outside");
    writeFileSync(outside, JSON.stringify(m));
    const link = join(tempRoot, "link");
    symlinkSync(outside, link);
    await expect(
      runRecoveryCommand(["recovery", "restore", tempRoot, backup, join(dataRoot, "x"), link], env),
    ).rejects.toThrow();
    const nestedOutside = join(root, "nested-out");
    mkdirSync(nestedOutside);
    symlinkSync(nestedOutside, join(tempRoot, "escape"));
    await expect(
      runRecoveryCommand(
        ["recovery", "restore", tempRoot, backup, join(dataRoot, "y"), join(tempRoot, "escape", "m.json")],
        env,
      ),
    ).rejects.toThrow();
    await expect(runRecoveryCommand(["recovery", "backup", tempRoot, source, backup, manifest], {})).rejects.toThrow();
  });

  it("retention is dry-run by default and requires deliberate apply confirmation", async () => {
    const root = mkdtempSync(join(tmpdir(), "iris-retention-cli-")),
      dataRoot = join(root, "data"),
      tempRoot = join(root, "temp");
    created.push(root);
    mkdirSync(dataRoot);
    mkdirSync(tempRoot);
    const source = join(dataRoot, "s.db"),
      backup = join(dataRoot, "b.db"),
      manifest = join(tempRoot, "m.json");
    const db = new Database(source);
    db.exec("create table t(v); insert into t values ('ok')");
    db.close();
    const raw = await createSqliteBackup(source, backup, { dataRoot, tempRoot });
    writeFileSync(manifest, JSON.stringify(makeRecoveryPairManifest(backup, { dataRoot, tempRoot }, raw)));
    const env = { IRIS_DATA_DIR: dataRoot };
    const out: string[] = [];
    await expect(runRecoveryCommand(["recovery", "retention", tempRoot, "0"], env)).rejects.toThrow(/minimumKeep/);
    await runRecoveryCommand(["recovery", "retention", tempRoot, "1"], env, (v) => out.push(v));
    expect(JSON.parse(out[0]).dryRun).toBe(true);
    expect(existsSync(backup)).toBe(true);
    expect(existsSync(manifest)).toBe(true);
    await expect(runRecoveryCommand(["recovery", "retention", tempRoot, "1", "apply"], env)).rejects.toThrow(
      /RETENTION_DELETE/,
    );
    await runRecoveryCommand(["recovery", "retention", tempRoot, "1", "apply"], {
      ...env,
      IRIS_RECOVERY_CONFIRM: "RETENTION_DELETE",
    });
    expect(existsSync(backup)).toBe(true); // minimumKeep protects the newest pair
  });
});
