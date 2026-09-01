import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateComfyWorkflowsDb } from "../src/admin/comfyui.js";
describe("workflow migration", () => {
  it("is idempotent, preserves rows, and rolls back fresh failure", () => {
    const db = new Database(":memory:");
    migrateComfyWorkflowsDb(false, db);
    db.prepare("insert into admin_comfy_workflows values(?,?,?,?,?)").run("1", "n", "{}", "a", "a");
    migrateComfyWorkflowsDb(false, db);
    expect(db.prepare("select count(*) n from admin_comfy_workflows_schema_migrations").get()).toEqual({ n: 1 });
    expect(db.prepare("select name from admin_comfy_workflows").get()).toEqual({ name: "n" });
    const fresh = new Database(":memory:");
    expect(() => migrateComfyWorkflowsDb(true, fresh)).toThrow();
    expect(fresh.prepare("select name from sqlite_master where name like 'admin_comfy_workflows%'").all()).toEqual([]);
  });
});
