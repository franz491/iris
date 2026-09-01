import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-guest-atomic-"));
  vi.resetModules();
});

const input = {
  userId: "guest",
  aiName: "Guest AI",
  aiModel: "guest-model",
  apiRouter: "openai-compat",
  maxContext: 4096,
  settings: { userInterruptions: true, aiInterruptions: false, forceAiReply: false, loadedTools: ["read_tool_info"] },
  name: "guest chat",
};

describe("atomic guest chat singleton", () => {
  it("serializes concurrent callers into one complete projection", async () => {
    const db = await import("../src/chat/database.js");
    db.migrateChatDb();
    const results = await Promise.all(Array.from({ length: 24 }, () => db.ensureGuestChatAtomic(input)));
    expect(new Set(results.map((result) => result.chatId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((db.chatSqlite.prepare("SELECT COUNT(*) AS n FROM chats").get() as { n: number }).n).toBe(1);
    expect((db.chatSqlite.prepare("SELECT COUNT(*) AS n FROM participants").get() as { n: number }).n).toBe(2);
    expect((db.chatSqlite.prepare("SELECT COUNT(*) AS n FROM chat_settings").get() as { n: number }).n).toBe(1);
    expect(db.chatSqlite.prepare("SELECT value FROM app_meta WHERE key='guest_chat_id'").pluck().get()).toBe(
      results[0]?.chatId,
    );
  });

  it("repairs an existing row and replaces stale metadata atomically", async () => {
    const db = await import("../src/chat/database.js");
    db.migrateChatDb();
    const created = db.ensureGuestChatAtomic(input);
    db.chatSqlite.prepare("UPDATE chats SET name=NULL WHERE id=?").run(created.chatId);
    db.chatSqlite
      .prepare(
        "UPDATE ai_participants SET model='old' WHERE participant_id IN (SELECT id FROM participants WHERE chat_id=?)",
      )
      .run(created.chatId);
    const repaired = db.ensureGuestChatAtomic(input);
    expect(repaired).toEqual({ chatId: created.chatId, created: false, repaired: true });
    expect(db.chatSqlite.prepare("SELECT name FROM chats WHERE id=?").pluck().get(created.chatId)).toBe("guest chat");
    expect(
      db.chatSqlite
        .prepare(
          "SELECT model FROM ai_participants WHERE participant_id IN (SELECT id FROM participants WHERE chat_id=?)",
        )
        .pluck()
        .get(created.chatId),
    ).toBe("guest-model");
    db.chatSqlite.prepare("DELETE FROM chats WHERE id=?").run(created.chatId);
    const replacement = db.ensureGuestChatAtomic(input);
    expect(replacement.created).toBe(true);
    expect(replacement.chatId).not.toBe(created.chatId);
    expect((db.chatSqlite.prepare("SELECT COUNT(*) AS n FROM chats").get() as { n: number }).n).toBe(1);
  });

  it("never returns a metadata pointer to a registered/private chat", async () => {
    const db = await import("../src/chat/database.js");
    db.migrateChatDb();
    const privateId = db.createChatAtomic(
      [
        { role: "user", name: "private", userId: "registered-user" },
        { role: "ai", name: "private ai", model: "private-model", apiRouter: "openai-compat" },
      ],
      input.settings,
      "private chat",
    );
    db.chatSqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('guest_chat_id', ?)").run(privateId);
    const replacement = db.ensureGuestChatAtomic(input);
    expect(replacement.created).toBe(true);
    expect(replacement.chatId).not.toBe(privateId);
    expect(db.chatSqlite.prepare("SELECT value FROM app_meta WHERE key='guest_chat_id'").pluck().get()).toBe(
      replacement.chatId,
    );
    expect(db.chatSqlite.prepare("SELECT name FROM chats WHERE id=?").pluck().get(privateId)).toBe("private chat");
    expect(
      db.chatSqlite
        .prepare(
          "SELECT user_id FROM user_participants WHERE participant_id IN (SELECT id FROM participants WHERE chat_id=?)",
        )
        .pluck()
        .get(privateId),
    ).toBe("registered-user");
  });

  it("rolls back invalid-pointer replacement and retries without exposing it", async () => {
    const db = await import("../src/chat/database.js");
    db.migrateChatDb();
    const privateId = db.createChatAtomic(
      [{ role: "user", name: "private", userId: "registered-user" }],
      input.settings,
      "private chat",
    );
    db.chatSqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('guest_chat_id', ?)").run(privateId);
    expect(() =>
      db.ensureGuestChatAtomic({
        ...input,
        faultAt: (boundary) => {
          if (boundary === "metadata") throw new Error("fault");
        },
      }),
    ).toThrow("fault");
    expect(db.chatSqlite.prepare("SELECT value FROM app_meta WHERE key='guest_chat_id'").pluck().get()).toBe(privateId);
    const replacement = db.ensureGuestChatAtomic(input);
    expect(replacement.created).toBe(true);
    expect(replacement.chatId).not.toBe(privateId);
  });

  it.each([
    "chat_row",
    "participant_user",
    "participant_ai",
    "ai_subtype",
    "user_subtype",
    "settings",
    "metadata",
    "pre_commit",
  ])("rolls back projection and metadata when %s fails", async (boundary) => {
    const db = await import("../src/chat/database.js");
    db.migrateChatDb();
    expect(() =>
      db.ensureGuestChatAtomic({
        ...input,
        faultAt: (name) =>
          name === boundary &&
          (() => {
            throw new Error("fault");
          })(),
      }),
    ).toThrow("fault");
    for (const table of [
      "chats",
      "participants",
      "user_participants",
      "ai_participants",
      "chat_settings",
      "app_meta",
    ]) {
      expect((db.chatSqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    expect(db.ensureGuestChatAtomic(input).created).toBe(true);
  });

  it("works through a second SQLite connection against the same database", async () => {
    const db = await import("../src/chat/database.js");
    const { dataFile } = await import("../src/db/sqlite.js");
    db.migrateChatDb();
    const second = new Database(dataFile("chat.db"));
    try {
      const first = db.ensureGuestChatAtomic(input);
      const again = db.ensureGuestChatAtomicOn(second, input);
      expect(again).toEqual({ chatId: first.chatId, created: false, repaired: false });
      expect((second.prepare("SELECT COUNT(*) AS n FROM chats").get() as { n: number }).n).toBe(1);
    } finally {
      second.close();
    }
  });
});
