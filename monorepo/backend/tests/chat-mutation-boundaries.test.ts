import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-chat-mutations-"));
  vi.resetModules();
});

describe("transactional chat mutation boundaries", () => {
  it("does not use a message from another chat as a deletion reference", async () => {
    const db = await import("../src/chat/database.js");
    db.migrateChatDb();
    const first = await import("../src/chat/chat.js").then((m) =>
      m.createChat([{ role: "user", name: "first", userId: "first" }]),
    );
    const second = await import("../src/chat/chat.js").then((m) =>
      m.createChat([{ role: "user", name: "second", userId: "second" }]),
    );
    const firstUser = (await db.getParticipantsRows(first.id))[0];
    const secondUser = (await db.getParticipantsRows(second.id))[0];
    await db.insertMessage({
      chatId: first.id,
      authorId: firstUser.id,
      type: "text",
      thought: "",
      content: "must remain",
    });
    const foreign = await db.insertMessage({
      chatId: second.id,
      authorId: secondUser.id,
      type: "text",
      thought: "",
      content: "foreign reference",
    });

    await expect(db.deleteMessageAndFollowing(first.id, foreign.id)).rejects.toThrow(/not found/);
    expect((await db.getHistoryPage(first.id, null, 50)).messages.map((message) => message.content)).toEqual([
      "must remain",
    ]);
  });

  it.each(["participant_names", "ai_identity", "pre_commit"])(
    "propagating a card rolls back when %s fails",
    async (boundary) => {
      const db = await import("../src/chat/database.js");
      db.migrateChatDb();
      const chat = await import("../src/chat/chat.js").then((m) =>
        m.createChat([{ role: "ai", name: "old", model: "old-model", apiRouter: "openai-compat", cardId: "card-1" }]),
      );
      const before = await db.getParticipantsRows(chat.id);
      await expect(
        db.propagateCard(
          "card-1",
          { name: "new", model: "new-model", apiRouter: "openai-compat", maxContext: 4096, prompt: "new prompt" },
          {
            faultAt: (name) => {
              if (name === boundary) throw new Error("fault");
            },
          },
        ),
      ).rejects.toThrow("fault");
      expect(await db.getParticipantsRows(chat.id)).toEqual(before);
    },
  );

  it("runs the post-commit callback exactly once for successful mutations", async () => {
    const db = await import("../src/chat/database.js");
    db.migrateChatDb();
    let committed = 0;
    db.createChatAtomic(
      [{ role: "user", name: "u", userId: "u" }],
      { userInterruptions: true, aiInterruptions: false, forceAiReply: false, loadedTools: ["read_tool_info"] },
      undefined,
      { onCommitted: () => committed++ },
    );
    expect(committed).toBe(1);
  });

  it.each(["branch_deleted", "message_rewritten", "cursors_reset", "pre_commit"])(
    "rewriting a branch rolls back when %s fails",
    async (boundary) => {
      const db = await import("../src/chat/database.js");
      db.migrateChatDb();
      const chat = await import("../src/chat/chat.js").then((m) =>
        m.createChat([{ role: "user", name: "u", userId: "u" }]),
      );
      const user = (await db.getParticipantsRows(chat.id))[0];
      const first = await db.insertMessage({
        chatId: chat.id,
        authorId: user.id,
        type: "text",
        thought: "",
        content: "first",
      });
      await db.insertMessage({ chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "followup" });
      await expect(
        db.rewriteMessageBranch(
          chat.id,
          first.id,
          { content: "rewritten" },
          {
            faultAt: (name) => {
              if (name === boundary) throw new Error("fault");
            },
          },
        ),
      ).rejects.toThrow("fault");
      const rows = await db.getHistoryPage(chat.id, null, 50);
      expect(rows.messages.map((row) => row.content)).toEqual(["first", "followup"]);
    },
  );
});
