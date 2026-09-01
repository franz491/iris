import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateAdminDb } from "../src/admin/store.js";
describe("admin migration ledger", () => {
  it("records v1 idempotently and rolls back fresh failure", () => {
    const db = new Database(":memory:");
    migrateAdminDb(false, db);
    db.prepare("insert into admin_state values(1,1,'{}','now')").run();
    migrateAdminDb(false, db);
    expect(db.prepare("select count(*) n from admin_schema_migrations").get()).toEqual({ n: 1 });
    expect(db.prepare("select version from admin_state").get()).toEqual({ version: 1 });
    const fresh = new Database(":memory:");
    expect(() => migrateAdminDb(true, fresh)).toThrow();
    expect(fresh.prepare("select name from sqlite_master where name like 'admin_%'").all()).toEqual([]);
  });
});
