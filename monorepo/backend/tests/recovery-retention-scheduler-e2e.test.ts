import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createSqliteBackup, makeRecoveryPairManifest } from "../src/db/recovery.js";
import { RecoveryRetentionScheduler } from "../src/db/recovery-retention-scheduler.js";
import { metricsSnapshot, resetMetrics } from "../src/misc/metrics.js";
const created: string[] = [];
afterEach(() => {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("recovery retention scheduler real apply", () => {
  it("deletes the older pair and records metrics", async () => {
    resetMetrics();
    const root = mkdtempSync(join(tmpdir(), "iris-retention-scheduler-"));
    created.push(root);
    const dataRoot = join(root, "data"),
      tempRoot = join(root, "temp");
    mkdirSync(dataRoot);
    mkdirSync(tempRoot);
    const source = join(dataRoot, "source.db");
    const db = new Database(source);
    db.exec("create table t(v); insert into t values ('x')");
    db.close();
    for (const [name, createdAt] of [
      ["old", "2020-01-01T00:00:00.000Z"],
      ["new", "2030-01-01T00:00:00.000Z"],
    ] as const) {
      const backup = join(dataRoot, `${name}.db`),
        manifest = join(tempRoot, `${name}.json`),
        roots = { dataRoot, tempRoot };
      const raw = await createSqliteBackup(source, backup, roots);
      writeFileSync(
        manifest,
        JSON.stringify({ ...makeRecoveryPairManifest(backup, roots, raw), manifest: { ...raw, createdAt } }),
      );
    }
    const timers: (() => void)[] = [];
    const scheduler = new RecoveryRetentionScheduler(
      { dataRoot, tempRoot },
      { enabled: true, intervalMs: 10, minimumKeep: 1, apply: true, confirmation: "RETENTION_DELETE" },
      {
        setTimer: (cb) => {
          timers.push(cb);
          return timers.length as never;
        },
      },
    );
    scheduler.start();
    await Promise.resolve();
    scheduler.stop();
    expect(existsSync(join(dataRoot, "old.db"))).toBe(false);
    expect(existsSync(join(tempRoot, "old.json"))).toBe(false);
    expect(existsSync(join(dataRoot, "new.db"))).toBe(true);
    expect(existsSync(join(tempRoot, "new.json"))).toBe(true);
    const snapshot = metricsSnapshot();
    expect(snapshot.requests["recovery_retention.apply_runs"]).toBe(1);
    expect(snapshot.requests["recovery_retention.pairs_deleted"]).toBe(1);
    expect(snapshot.requests["recovery_retention.runs_completed"]).toBe(1);
    expect(snapshot.requests["recovery_retention.runs_failed"]).toBeUndefined();
    expect(snapshot.gauges["recovery_retention.active"]).toBe(0);
    expect(snapshot.durationsMs["recovery_retention.duration_ms"].count).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain(root);
  });
});
