import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-history-performance-"));
});

describe("history query performance contract", () => {
  it("retrieves a 5,000-message history in bounded deterministic pages", async () => {
    const { migrateChatDb, chatSqlite, getHistoryPage } = await import("../src/chat/database.js");
    migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([{ role: "user", name: "user", userId: "history-user" }]);
    const author = (await chat.getParticipants())[0];
    const total = 5000;
    const limit = 100;
    chatSqlite.transaction(() => {
      const insert = chatSqlite.prepare(
        "INSERT INTO messages (id, chat_id, author_id, type, thought, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (let i = 1; i <= total; i++)
        insert.run(`history-${i}`, chat.id, author.id, "text", "", `history-message-${i}`, i, i);
    })();

    const seen: number[] = [];
    let before: number | null = null;
    let pages = 0;
    while (true) {
      const page = await getHistoryPage(chat.id, before, limit);
      pages++;
      expect(page.messages.length).toBeLessThanOrEqual(limit);
      seen.unshift(...page.messages.map((message) => Number(message.content.replace("history-message-", ""))));
      if (!page.hasMore) break;
      before = page.oldestSeq;
    }
    expect(pages).toBe(total / limit);
    expect(seen).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(new Set(seen).size).toBe(total);
    expect({ total, limit, pages, returned: seen.length }).toEqual({
      total: 5000,
      limit: 100,
      pages: 50,
      returned: 5000,
    });
  });
});
