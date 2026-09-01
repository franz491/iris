import { describe, expect, it } from "vitest";
import { closeAllDatabases, openDb, dataFile } from "../src/db/sqlite.js";

describe("SQLite shutdown ownership", () => {
  it("closes registered handles idempotently", () => {
    const { sqlite } = openDb(dataFile(`shutdown-${Date.now()}.db`));
    sqlite.exec("CREATE TABLE IF NOT EXISTS probe (id INTEGER)");
    closeAllDatabases();
    expect(() => closeAllDatabases()).not.toThrow();
    expect(() => sqlite.exec("SELECT 1")).toThrow();
  });
});
