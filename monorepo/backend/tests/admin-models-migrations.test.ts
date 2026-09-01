import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateModelsDb } from "../src/admin/models.js";
describe("models migration", () => {
  it("is idempotent, preserves rows, and rolls back fresh failure", () => {
    const db = new Database(":memory:");
    migrateModelsDb(false, db);
    db.prepare("insert into admin_models values(?,?,?,?,?,?,?)").run("1", "n", "/x", "external", null, "x", "now");
    migrateModelsDb(false, db);
    expect(db.prepare("select count(*) n from admin_models_schema_migrations").get()).toEqual({ n: 1 });
    expect(db.prepare("select name from admin_models").get()).toEqual({ name: "n" });
    const fresh = new Database(":memory:");
    expect(() => migrateModelsDb(true, fresh)).toThrow();
    expect(fresh.prepare("select name from sqlite_master where name like 'admin_models%'").all()).toEqual([]);
  });
});
