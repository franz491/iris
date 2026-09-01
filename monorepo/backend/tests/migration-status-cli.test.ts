import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runMigrationCommand } from "../src/cli/migration.js";
import { MIGRATION_REGISTRY } from "../src/db/migration-status.js";
const created: string[] = [];
afterEach(() => {
  for (const r of created.splice(0)) rmSync(r, { recursive: true, force: true });
});
describe("migration status CLI surface", () => {
  it("rejects missing data root", () => {
    expect(() => runMigrationCommand(["migration", "status"], { IRIS_RECOVERY_CONFIRM: "CLOSED_HANDLES" })).toThrow();
  });
  it("rejects newer ledger", () => {
    const root = mkdtempSync(path.join(tmpdir(), "iris-status-cli-"));
    created.push(root);
    const db = new Database(path.join(root, "chat.db"));
    db.exec("create table chat_schema_migrations(version integer); insert into chat_schema_migrations values(2)");
    db.close();
    expect(() =>
      runMigrationCommand(["migration", "status"], { IRIS_DATA_DIR: root, IRIS_RECOVERY_CONFIRM: "CLOSED_HANDLES" }),
    ).toThrow();
  });
  it("reports all registry families current", () => {
    const root = mkdtempSync(path.join(tmpdir(), "iris-status-cli-"));
    created.push(root);
    for (const file of ["chat.db", "prompts.db", "memory.db", "config.db", "admin.db"]) {
      const db = new Database(path.join(root, file));
      for (const e of MIGRATION_REGISTRY.filter((x) => x.database === file))
        db.exec(`create table ${e.ledger}(version integer); insert into ${e.ledger} values(1)`);
      db.close();
    }
    const out: string[] = [];
    runMigrationCommand(
      ["migration", "status"],
      { IRIS_DATA_DIR: root, IRIS_RECOVERY_CONFIRM: "CLOSED_HANDLES" },
      (x) => out.push(x),
    );
    const report = JSON.parse(out[0]);
    expect(report).toHaveLength(MIGRATION_REGISTRY.length);
    expect(report.every((x: any) => x.result.status === "current")).toBe(true);
  });
  it("rejects malformed args and confirmation", () => {
    expect(() => runMigrationCommand(["migration"], {})).toThrow();
    expect(() => runMigrationCommand(["migration", "foo"], {})).toThrow();
    expect(() => runMigrationCommand(["migration", "status", "extra"], {})).toThrow();
    expect(() =>
      runMigrationCommand(["migration", "status"], { IRIS_DATA_DIR: "/tmp", IRIS_RECOVERY_CONFIRM: "wrong" }),
    ).toThrow();
  });
  it("reports missing and old families", () => {
    const root = mkdtempSync(path.join(tmpdir(), "iris-status-cli-"));
    created.push(root);
    const out: string[] = [];
    runMigrationCommand(
      ["migration", "status"],
      { IRIS_DATA_DIR: root, IRIS_RECOVERY_CONFIRM: "CLOSED_HANDLES" },
      (x) => out.push(x),
    );
    expect(out[0]).toContain('"status":"missing"');
    const db = new Database(path.join(root, "chat.db"));
    db.exec("create table chat_schema_migrations(version integer); insert into chat_schema_migrations values(0)");
    db.close();
    out.length = 0;
    runMigrationCommand(
      ["migration", "status"],
      { IRIS_DATA_DIR: root, IRIS_RECOVERY_CONFIRM: "CLOSED_HANDLES" },
      (x) => out.push(x),
    );
    expect(out[0]).toContain('"status":"old"');
  });
  it("is deterministic and non-mutating", () => {
    const root = mkdtempSync(path.join(tmpdir(), "iris-status-cli-"));
    created.push(root);
    const db = new Database(path.join(root, "chat.db"));
    db.exec("create table chat_schema_migrations(version integer); insert into chat_schema_migrations values(1)");
    db.close();
    const before = createHash("sha256")
        .update(readFileSync(path.join(root, "chat.db")))
        .digest("hex"),
      mtime = statSync(path.join(root, "chat.db")).mtimeMs;
    const env = { IRIS_DATA_DIR: root, IRIS_RECOVERY_CONFIRM: "CLOSED_HANDLES" },
      out: string[] = [];
    runMigrationCommand(["migration", "status"], env, (s) => out.push(s));
    expect(out[0]).toContain("chat_schema_migrations");
    runMigrationCommand(["migration", "dry-run"], env, (s) => out.push(s));
    expect(
      createHash("sha256")
        .update(readFileSync(path.join(root, "chat.db")))
        .digest("hex"),
    ).toBe(before);
    expect(statSync(path.join(root, "chat.db")).mtimeMs).toBe(mtime);
  });
  it("rejects corrupt status", () => {
    const root = mkdtempSync(path.join(tmpdir(), "iris-status-cli-"));
    created.push(root);
    writeFileSync(path.join(root, "chat.db"), "bad");
    expect(() =>
      runMigrationCommand(["migration", "status"], { IRIS_DATA_DIR: root, IRIS_RECOVERY_CONFIRM: "CLOSED_HANDLES" }),
    ).toThrow();
  });
});
