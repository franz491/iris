import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateConfigDb } from "../src/runtime/config-parser.js";
describe("config migration ledger", () => {
  it("is idempotent, preserves data, and rolls back fresh failure", () => {
    const db = new Database(":memory:");
    migrateConfigDb(db);
    db.prepare("insert into provider_configs values(?,?,?)").run("x", "[]", "{}");
    migrateConfigDb(db);
    expect(db.prepare("select count(*) n from config_schema_migrations").get()).toEqual({ n: 1 });
    expect(db.prepare("select name from provider_configs").get()).toEqual({ name: "x" });
    const fresh = new Database(":memory:");
    expect(() => migrateConfigDb(fresh, true)).toThrow();
    expect(fresh.prepare("select name from sqlite_master where name like '%configs%'").all()).toEqual([]);
  });
});
