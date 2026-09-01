import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-memory-mig-"));
  vi.resetModules();
});
describe("memory migration ledger", () => {
  it("is idempotent, preserves rows, and rolls back fresh failure", async () => {
    const { sqlite, migrateMemoryDb } = await import("../src/memory/sql.js");
    migrateMemoryDb();
    sqlite
      .prepare("insert into memories(id,type,keyword,content,created_at,is_private) values(?,?,?,?,?,?)")
      .run("a", "agent", "k", "v", 1, 0);
    migrateMemoryDb();
    expect(sqlite.prepare("select count(*) n from memory_schema_migrations").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("select content from memories").pluck().get()).toBe("v");
  });
});
