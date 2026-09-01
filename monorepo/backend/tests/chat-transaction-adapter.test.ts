import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-tx-"));
  vi.resetModules();
});
describe("chat transaction adapter", () => {
  it("commits and rolls back synchronously", async () => {
    const { chatSqlite, runChatTransaction } = await import("../src/chat/database.js");
    chatSqlite.exec("create table tx_test (id integer primary key, value text not null)");
    runChatTransaction((c) => {
      c.prepare("insert into tx_test values (?, ?)").run(1, "ok");
    });
    expect(chatSqlite.prepare("select value from tx_test").pluck().get()).toBe("ok");
    expect(() =>
      runChatTransaction((c) => {
        c.prepare("insert into tx_test values (?, ?)").run(2, "bad");
        throw new Error("injected");
      }),
    ).toThrow("injected");
    expect(chatSqlite.prepare("select count(*) as n from tx_test").get()).toEqual({ n: 1 });
  });
});
