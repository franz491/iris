import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateBootstrapDb } from "../src/admin/bootstrap.js";
describe("bootstrap migration", () => {
  it("is idempotent and rolls back fresh failure", () => {
    const db = new Database(":memory:");
    migrateBootstrapDb(false, db);
    db.prepare("insert into admin_bootstrap values(1,'h',10,0)").run();
    migrateBootstrapDb(false, db);
    expect(db.prepare("select count(*) n from admin_bootstrap_schema_migrations").get()).toEqual({ n: 1 });
    expect(() => migrateBootstrapDb(true, new Database(":memory:"))).toThrow();
  });
});
