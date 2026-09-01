import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-prompt-performance-"));
});

describe("prompt construction performance contract", () => {
  it("builds deterministic contexts for 5,000 messages and multiple AIs", async () => {
    const { migrateChatDb, chatSqlite } = await import("../src/chat/database.js");
    migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "user", userId: "user-1" },
      { role: "ai", name: "alpha", model: "test", prompt: "" },
      { role: "ai", name: "beta", model: "test", prompt: "" },
    ]);
    const participants = await chat.getParticipants();
    const author = participants.find((participant) => participant.role === "user")!;
    const rows = Array.from({ length: 5000 }, (_, i) => [
      `perf-${i}`,
      chat.id,
      author.id,
      "text",
      "",
      `message-${i}`,
      i + 1,
      i + 1,
    ]);
    chatSqlite.transaction(() => {
      const insert = chatSqlite.prepare(
        "INSERT INTO messages (id, chat_id, author_id, type, thought, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of rows) insert.run(...row);
    })();
    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const ai = participants.filter((participant) => participant.role === "ai");
    const contexts = await Promise.all(ai.map((participant) => getContextForAi(chat.id, participant)));
    expect(contexts).toHaveLength(2);
    expect(contexts.map((context) => context.filter((entry) => entry.role === "user").length)).toEqual([1, 1]);
    expect(contexts.every((context) => context.some((entry) => String(entry.content).includes("message-0")))).toBe(
      true,
    );
    expect(contexts.every((context) => context.some((entry) => String(entry.content).includes("message-4999")))).toBe(
      true,
    );
    expect({ messages: rows.length, aiParticipants: ai.length, contexts: contexts.length }).toEqual({
      messages: 5000,
      aiParticipants: 2,
      contexts: 2,
    });
  });
});
