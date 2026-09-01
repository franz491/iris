import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-ai-participants-"));
  vi.resetModules();
});

describe("persisted provider tool-call context", () => {
  it("keeps valid calls while dropping malformed and oversized calls", async () => {
    const database = await import("../src/chat/database.js");
    database.migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "user", userId: "user-1" },
      { role: "ai", name: "bot", model: "test-model" },
    ]);
    const participants = await chat.getParticipants();
    const user = participants.find((participant) => participant.role === "user")!;
    const ai = participants.find((participant) => participant.role === "ai")!;
    const { MAX_TOOL_ARGUMENT_BYTES } = await import("../src/chat/tools.js");

    await database.insertMessage({
      chatId: chat.id,
      authorId: ai.id,
      type: "tool",
      thought: "",
      content: JSON.stringify([
        { name: "valid_tool", arguments: JSON.stringify({ value: "kept" }) },
        { name: "missing-arguments" },
        { name: "oversized_tool", arguments: "x".repeat(MAX_TOOL_ARGUMENT_BYTES + 1) },
        null,
      ]),
    });
    await database.insertMessage({
      chatId: chat.id,
      authorId: user.id,
      type: "text",
      thought: "",
      content: "continue",
    });

    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const context = await getContextForAi(chat.id, ai);
    const toolEntry = context.find((entry) => entry.role === "assistant" && entry.tool_calls);

    expect(toolEntry?.tool_calls).toEqual([
      {
        id: expect.stringContaining("iris-"),
        type: "function",
        function: { name: "valid_tool", arguments: JSON.stringify({ value: "kept" }) },
      },
    ]);
    expect(context.some((entry) => entry.content === "user: continue")).toBe(true);
  });

  it("fails an oversized tool-call batch safely", async () => {
    const database = await import("../src/chat/database.js");
    database.migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "user", userId: "user-1" },
      { role: "ai", name: "bot", model: "test-model" },
    ]);
    const ai = (await chat.getParticipants()).find((participant) => participant.role === "ai")!;
    const { MAX_STORED_TOOL_CALL_BYTES } = await import("../src/chat/ai-participants.js");

    await database.insertMessage({
      chatId: chat.id,
      authorId: ai.id,
      type: "tool",
      thought: "",
      content: '["' + "x".repeat(MAX_STORED_TOOL_CALL_BYTES) + '"]',
    });

    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const context = await getContextForAi(chat.id, ai);
    const toolEntry = context.find((entry) => entry.role === "assistant" && entry.tool_calls);
    expect(toolEntry?.tool_calls).toEqual([]);
  });

  it("does not treat malformed, scalar, or oversized tool results as result objects", async () => {
    const database = await import("../src/chat/database.js");
    database.migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "user", userId: "user-1" },
      { role: "ai", name: "bot", model: "test-model" },
    ]);
    const ai = (await chat.getParticipants()).find((participant) => participant.role === "ai")!;
    const { MAX_STORED_TOOL_RESULT_BYTES } = await import("../src/chat/ai-participants.js");
    const contents = [
      "not-json",
      JSON.stringify("scalar result"),
      JSON.stringify(["array result"]),
      "{" + "x".repeat(MAX_STORED_TOOL_RESULT_BYTES) + "}",
      JSON.stringify({ tool: "valid", result: { kept: true } }),
    ];
    for (const content of contents) {
      await database.insertMessage({
        chatId: chat.id,
        authorId: ai.id,
        type: "tool_result",
        thought: "",
        content,
      });
    }

    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const results = (await getContextForAi(chat.id, ai)).filter((entry) => entry.role === "tool");

    expect(results.map((entry) => entry.content)).toEqual([
      "not-json",
      JSON.stringify("scalar result"),
      JSON.stringify(["array result"]),
      "{" + "x".repeat(MAX_STORED_TOOL_RESULT_BYTES) + "}",
      JSON.stringify({ kept: true }),
    ]);
  });
});
