import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-atomic-"));
  vi.resetModules();
});
describe("AI participant atomicity", () => {
  it("rolls back both rows on second insert failure and commits valid rows", async () => {
    const { chatSqlite, createChatRow, insertParticipant, migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const chat = await createChatRow();
    await expect(insertParticipant(chat.id, { role: "ai", name: "bad", model: "m", maxContext: 0 })).rejects.toThrow();
    expect(chatSqlite.prepare("select count(*) n from participants where chat_id=?").get(chat.id)).toEqual({ n: 0 });
    expect(chatSqlite.prepare("select count(*) n from ai_participants").get()).toEqual({ n: 0 });
    await insertParticipant(chat.id, { role: "ai", name: "good", model: "m" });
    expect(chatSqlite.prepare("select count(*) n from participants where chat_id=?").get(chat.id)).toEqual({ n: 1 });
    expect(chatSqlite.prepare("select count(*) n from ai_participants").get()).toEqual({ n: 1 });
  });
});
