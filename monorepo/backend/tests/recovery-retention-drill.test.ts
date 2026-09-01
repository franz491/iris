import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRecoveryCommand } from "../src/cli/recovery.js";
import {
  applyRecoveryRetention,
  createSqliteBackup,
  makeRecoveryPairManifest,
  planRecoveryRetention,
} from "../src/db/recovery.js";

describe("offline recovery retention drill", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("dry-runs, retains newest minimum, removes exact older pair, and fails closed on tamper", async () => {
    const root = mkdtempSync(join(tmpdir(), "iris-retention-drill-"));
    created.push(root);
    const dataRoot = join(root, "data"),
      tempRoot = join(root, "temp");
    mkdirSync(dataRoot);
    mkdirSync(tempRoot);
    const source = join(dataRoot, "source.db");
    const db = new Database(source);
    db.exec("create table t(v); insert into t values ('drill')");
    db.close();
    const roots = { dataRoot, tempRoot };
    const oldBackup = join(dataRoot, "old.db"),
      newBackup = join(dataRoot, "new.db");
    const oldManifest = join(tempRoot, "old.json"),
      newManifest = join(tempRoot, "new.json");
    const oldRaw = await createSqliteBackup(source, oldBackup, roots),
      newRaw = await createSqliteBackup(source, newBackup, roots);
    writeFileSync(
      oldManifest,
      JSON.stringify({
        ...makeRecoveryPairManifest(oldBackup, roots, oldRaw),
        manifest: { ...oldRaw, createdAt: "2020-01-01T00:00:00.000Z" },
      }),
    );
    writeFileSync(
      newManifest,
      JSON.stringify({
        ...makeRecoveryPairManifest(newBackup, roots, newRaw),
        manifest: { ...newRaw, createdAt: "2030-01-01T00:00:00.000Z" },
      }),
    );
    const env = { IRIS_DATA_DIR: dataRoot },
      out: string[] = [];
    await runRecoveryCommand(["recovery", "retention", tempRoot, "1"], env, (value) => out.push(value));
    expect(JSON.parse(out[0])).toMatchObject({ dryRun: true });
    expect(existsSync(oldBackup)).toBe(true);
    expect(existsSync(oldManifest)).toBe(true);
    const planOut: string[] = [];
    await runRecoveryCommand(
      ["recovery", "retention", tempRoot, "1", "apply"],
      { ...env, IRIS_RECOVERY_CONFIRM: "RETENTION_DELETE" },
      (value) => planOut.push(value),
    );
    expect(existsSync(oldBackup)).toBe(false);
    expect(existsSync(oldManifest)).toBe(false);
    expect(existsSync(newBackup)).toBe(true);
    expect(existsSync(newManifest)).toBe(true);
    expect(JSON.parse(planOut[0]).remove).toEqual([oldManifest, oldBackup]);
    const tamperRoot = mkdtempSync(join(tmpdir(), "iris-retention-tamper-"));
    created.push(tamperRoot);
    const tamperData = join(tamperRoot, "data"),
      tamperTemp = join(tamperRoot, "temp");
    mkdirSync(tamperData);
    mkdirSync(tamperTemp);
    const tamperSource = join(tamperData, "source.db");
    writeFileSync(tamperSource, readFileSync(source));
    const tamperBackup = join(tamperData, "tamper.db"),
      tamperManifest = join(tamperTemp, "tamper.json");
    const tamperRaw = await createSqliteBackup(tamperSource, tamperBackup, {
      dataRoot: tamperData,
      tempRoot: tamperTemp,
    });
    writeFileSync(
      tamperManifest,
      JSON.stringify(makeRecoveryPairManifest(tamperBackup, { dataRoot: tamperData, tempRoot: tamperTemp }, tamperRaw)),
    );
    const tamperPlan = planRecoveryRetention(tamperTemp, { dataRoot: tamperData, tempRoot: tamperTemp }, 1);
    writeFileSync(tamperBackup, "tampered");
    expect(() => applyRecoveryRetention(tamperPlan, { dataRoot: tamperData, tempRoot: tamperTemp }, false)).toThrow();
    expect(existsSync(tamperManifest)).toBe(true);
  });
});
