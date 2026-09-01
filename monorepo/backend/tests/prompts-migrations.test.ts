import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-prompts-mig-"));
  vi.resetModules();
});
describe("prompt migration ledger", () => {
  it("records once and preserves data", async () => {
    const { sqlite, migratePromptsDb } = await import("../src/prompts/prompts.js");
    migratePromptsDb();
    sqlite.prepare("insert into prompt_prefs(key,user_id,value) values(?,?,?)").run("k", null, "v");
    migratePromptsDb();
    expect(sqlite.prepare("select count(*) n from prompts_schema_migrations").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("select value from prompt_prefs").pluck().get()).toBe("v");
  });
  it("rolls back fresh schema on injected failure", async () => {
    const { sqlite, migratePromptsDb } = await import("../src/prompts/prompts.js");
    expect(() => migratePromptsDb(true)).toThrow();
    expect(
      sqlite.prepare("select name from sqlite_master where name in ('prompt_prefs','prompts_schema_migrations')").all(),
    ).toEqual([]);
  });
});
