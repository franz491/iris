import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-compaction-"));
  vi.resetModules();
});

async function setup() {
  const database = await import("../src/chat/database.js");
  database.migrateChatDb();
  const { createChat } = await import("../src/chat/chat.js");
  const chat = await createChat([
    { role: "user", name: "user", userId: "user-1" },
    { role: "ai", name: "bot", model: "test-model" },
  ]);
  const participants = await chat.getParticipants();
  return {
    chat,
    user: participants.find((p) => p.role === "user")!,
    ai: participants.find((p) => p.role === "ai")!,
    database,
  };
}

describe("AI compaction cursors", () => {
  it("reads legacy ISO timestamp cursors and continues after an image", async () => {
    const { chat, user, ai, database } = await setup();
    const image = await database.insertMessage({
      chatId: chat.id,
      authorId: user.id,
      type: "file",
      thought: "",
      content: "[file] picture.png",
    });
    await database.updateAiParticipant(ai.id, {
      lastCompactedMessageId: image.createdAt.toISOString(),
      compactedContext: "The user uploaded an image.",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await database.insertMessage({
      chatId: chat.id,
      authorId: user.id,
      type: "text",
      thought: "",
      content: "what is in it?",
    });

    const freshAi = await database.getParticipant(ai.id);
    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const context = await getContextForAi(chat.id, freshAi as never);

    expect(context.some((entry) => String(entry.content).includes("The user uploaded an image."))).toBe(true);
    expect(context.some((entry) => String(entry.content).includes("what is in it?"))).toBe(true);
  });

  it("stores the latest message ID when creating a new compaction", async () => {
    const { chat, user, ai, database } = await setup();
    const message = await database.insertMessage({
      chatId: chat.id,
      authorId: user.id,
      type: "text",
      thought: "",
      content: "remember this",
    });
    const router = await import("../src/model-router/model-manager.js");
    router.registerApiRouter("openai-compat", {
      async *complete() {
        yield { delta: "summary" };
      },
      async completeOnce() {
        return { content: "summary" };
      },
    });

    const { compactChat } = await import("../src/chat/ai-participants.js");
    await compactChat(ai as never);
    const freshAi = await database.getParticipant(ai.id);

    expect(freshAi.role).toBe("ai");
    expect(freshAi.role === "ai" && freshAi.lastCompactedMessageId).toBe(message.id);
  });
});
