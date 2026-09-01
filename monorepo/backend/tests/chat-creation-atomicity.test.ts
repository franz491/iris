import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-chat-atomic-"));
  vi.resetModules();
});

const settings = {
  userInterruptions: true,
  aiInterruptions: false,
  forceAiReply: false,
  loadedTools: ["read_tool_info"],
};
const participants = [
  { role: "user" as const, name: "owner", userId: "u1" },
  { role: "ai" as const, name: "assistant", model: "model", apiRouter: "openai-compat" },
];

describe("atomic chat creation", () => {
  it.each(["chat_row", "participant_user", "user_subtype", "participant_ai", "ai_subtype", "settings", "pre_commit"])(
    "rolls back every table when %s fails",
    async (boundary) => {
      const db = await import("../src/chat/database.js");
      db.migrateChatDb();
      const before = Object.fromEntries(
        ["chats", "participants", "user_participants", "ai_participants", "chat_settings"].map((table) => [
          table,
          (db.chatSqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
        ]),
      );
      expect(() =>
        db.createChatAtomic(participants, settings, "atomic", {
          faultAt: (name) => {
            if (name === boundary) throw new Error("fault");
          },
        }),
      ).toThrow("fault");
      for (const [table, count] of Object.entries(before)) {
        expect((db.chatSqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count).toBe(
          count,
        );
      }
    },
  );

  it("commits once and registers only the committed instance", async () => {
    const db = await import("../src/chat/database.js");
    db.migrateChatDb();
    const chat = await (await import("../src/chat/chat.js")).createChat(participants, settings, "atomic");
    await expect((await import("../src/chat/chat.js")).getChat(chat.id)).resolves.toBe(chat);
    expect((db.chatSqlite.prepare("SELECT COUNT(*) AS count FROM chats").get() as { count: number }).count).toBe(1);
  });

  it("concurrent creates produce distinct complete projections", async () => {
    const db = await import("../src/chat/database.js");
    db.migrateChatDb();
    const ids = await Promise.all(Array.from({ length: 12 }, () => db.createChatAtomic(participants, settings)));
    expect(new Set(ids).size).toBe(12);
    expect((db.chatSqlite.prepare("SELECT COUNT(*) AS count FROM chats").get() as { count: number }).count).toBe(12);
    expect((db.chatSqlite.prepare("SELECT COUNT(*) AS count FROM participants").get() as { count: number }).count).toBe(
      24,
    );
  });
});
