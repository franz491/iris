import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspectMigrationLedger, inspectOwnedMigrations, MIGRATION_REGISTRY } from "../src/db/migration-status.js";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const dbWith = (file: string, version: number) => {
  const db = new Database(file);
  db.exec("create table migrations(version integer)");
  db.prepare("insert into migrations values(?)").run(version);
  db.close();
};
it("reports current and missing ledger", () => {
  const root = mkdtempSync(path.join(tmpdir(), "iris-status-"));
  roots.push(root);
  const file = path.join(root, "current");
  dbWith(file, 1);
  expect(inspectMigrationLedger(file, "migrations", 1, root).status).toBe("current");
  const empty = path.join(root, "empty");
  new Database(empty).close();
  expect(inspectMigrationLedger(empty, "migrations", 1, root).status).toBe("missing");
});
it("reports registry and rejects invalid arguments", () => {
  const root = mkdtempSync(path.join(tmpdir(), "iris-status-"));
  roots.push(root);
  expect(() => inspectMigrationLedger(path.join(root, "x"), "bad-name", 1, root)).toThrow();
  expect(() => inspectMigrationLedger(path.join(root, "x"), "ok", 0, root)).toThrow();
  expect(inspectOwnedMigrations(root)).toHaveLength(MIGRATION_REGISTRY.length);
});
it("classifies every ledger state and rejects escapes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "iris-status-"));
  expect(inspectMigrationLedger(path.join(root, "missing"), "migrations", 1, root).status).toBe("missing");
  dbWith(path.join(root, "old"), 0);
  expect(inspectMigrationLedger(path.join(root, "old"), "migrations", 1, root).status).toBe("old");
  dbWith(path.join(root, "new"), 2);
  expect(inspectMigrationLedger(path.join(root, "new"), "migrations", 1, root).status).toBe("newer");
  const bad = path.join(root, "bad");
  writeFileSync(bad, "garbage");
  expect(inspectMigrationLedger(bad, "migrations", 1, root).status).toBe("corrupt");
  const outside = mkdtempSync(path.join(tmpdir(), "iris-status-out-"));
  symlinkSync(outside, path.join(root, "link"));
  expect(() => inspectMigrationLedger(path.join(root, "link", "x"), "migrations", 1, root)).toThrow();
});
it("rejects final and root symlinks and permits rename after inspection", () => {
  const root = mkdtempSync(path.join(tmpdir(), "iris-status-"));
  const outside = mkdtempSync(path.join(tmpdir(), "iris-status-out-"));
  roots.push(root, outside);
  const file = path.join(root, "db");
  dbWith(file, 1);
  expect(inspectMigrationLedger(file, "migrations", 1, root).status).toBe("current");
  const moved = path.join(root, "moved");
  renameSync(file, moved);
  symlinkSync(moved, path.join(root, "link"));
  expect(() => inspectMigrationLedger(path.join(root, "link"), "migrations", 1, root)).toThrow();
  symlinkSync(root, path.join(outside, "root-link"));
  expect(() => inspectMigrationLedger(moved, "migrations", 1, path.join(outside, "root-link"))).toThrow();
});
