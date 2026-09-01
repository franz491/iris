import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-compaction-performance-"));
});

describe("compaction performance contract", () => {
  it("builds a bounded summary prompt without re-summarizing system context", async () => {
    const { migrateChatDb, chatSqlite, getParticipant } = await import("../src/chat/database.js");
    migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "user", userId: "compaction-user" },
      { role: "ai", name: "bot", model: "test", prompt: "private participant instructions" },
    ]);
    const participants = await chat.getParticipants();
    const author = participants.find((participant) => participant.role === "user")!;
    const total = 2_000;
    chatSqlite.transaction(() => {
      const insert = chatSqlite.prepare(
        "INSERT INTO messages (id, chat_id, author_id, type, thought, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (let i = 1; i <= total; i++) {
        insert.run(`compaction-${i}`, chat.id, author.id, "text", "", `conversation-message-${i}`, i, i);
      }
    })();

    let captured: import("../src/chat/types.js").ChatContext | undefined;
    const router = await import("../src/model-router/model-manager.js");
    router.registerApiRouter("openai-compat", {
      async *complete() {
        yield { delta: "unused" };
      },
      async completeOnce(request) {
        captured = request.context;
        return { content: "bounded summary" };
      },
    });

    const { compactChat } = await import("../src/chat/ai-participants.js");
    const ai = participants.find((participant) => participant.role === "ai")!;
    await compactChat(ai as never);

    expect(captured).toBeDefined();
    const conversation = captured!.filter((entry) => entry.role !== "system");
    const conversationBytes = conversation.reduce(
      (totalBytes, entry) => totalBytes + Buffer.byteLength(String(entry.content), "utf8"),
      0,
    );
    expect(conversation).toHaveLength(1);
    expect(String(conversation[0]?.content).includes("conversation-message-1")).toBe(true);
    expect(String(conversation[0]?.content).includes(`conversation-message-${total}`)).toBe(true);
    expect(String(conversation[0]?.content).match(/conversation-message-\d+/g)).toHaveLength(total);
    expect(captured!.filter((entry) => entry.role === "system")).toHaveLength(1);
    expect(conversationBytes).toBeLessThanOrEqual(total * 40);
    expect({ messages: total, summaryTurns: conversation.length, conversationBytes }).toEqual({
      messages: 2_000,
      summaryTurns: 1,
      conversationBytes,
    });

    const persisted = await getParticipant(ai.id);
    expect(persisted.role === "ai" && persisted.compactedContext).toBe("bounded summary");
    expect(persisted.role === "ai" && persisted.lastCompactedMessageId).toBe(`compaction-${total}`);
  });
});
