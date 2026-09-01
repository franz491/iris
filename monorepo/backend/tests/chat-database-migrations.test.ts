import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-chat-migrations-"));
  vi.resetModules();
});

describe("chat database migrations", () => {
  it("records the compatibility migration exactly once", async () => {
    const { chatSqlite, migrateChatDb } = await import("../src/chat/database.js");

    migrateChatDb();
    migrateChatDb();

    expect(
      chatSqlite.prepare("SELECT version, applied_at FROM chat_schema_migrations ORDER BY version").all(),
    ).toHaveLength(1);
    expect(chatSqlite.prepare("SELECT version FROM chat_schema_migrations").get()).toEqual({ version: 1 });
    expect(chatSqlite.prepare("SELECT applied_at FROM chat_schema_migrations").get()).toMatchObject({
      applied_at: expect.any(Number),
    });
  });

  it("preserves an oldest-schema message and remains idempotent", async () => {
    const { chatSqlite, migrateChatDb } = await import("../src/chat/database.js");
    chatSqlite.exec(
      `CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, author_id TEXT NOT NULL, type TEXT NOT NULL, thought TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, superseded_by TEXT); INSERT INTO messages VALUES ('old-1','chat-1','user-1','text','','legacy',1,NULL);`,
    );
    migrateChatDb();
    expect(chatSqlite.prepare("SELECT content FROM messages WHERE id='old-1'").get()).toEqual({ content: "legacy" });
    migrateChatDb();
    expect(chatSqlite.prepare("SELECT count(*) as n FROM chat_schema_migrations").get()).toEqual({ n: 1 });
  });

  it("keeps the migration record absent when a migration step fails", async () => {
    const { chatSqlite, migrateChatDb } = await import("../src/chat/database.js");

    // Force the existing compatibility step to fail after it has made a
    // transactional schema change. The trigger remains, while the ALTER TABLE
    // is rolled back along with the missing migration record.
    chatSqlite.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        type TEXT NOT NULL,
        thought TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        superseded_by TEXT
      );
      INSERT INTO messages (id, chat_id, author_id, type, created_at)
      VALUES ('message-1', 'chat-1', 'participant-1', 'text', 1);
      CREATE TRIGGER fail_seq_repair
      BEFORE UPDATE OF seq ON messages
      BEGIN SELECT RAISE(ABORT, 'intentional migration failure'); END;
    `);

    expect(() => migrateChatDb()).toThrow();
    expect(chatSqlite.prepare("SELECT 1 FROM chat_schema_migrations WHERE version = 1").get()).toBeUndefined();
  });
});
