import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-chat-lifecycle-"));
  vi.resetModules();
});

async function waitForGeneration(chat: { replyingParticipants: () => string[] }): Promise<void> {
  for (let i = 0; i < 50 && chat.replyingParticipants().length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
}

describe("chat instance lifecycle", () => {
  it("serializes simultaneous non-silent sends competing for one AI", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    let activeStreams = 0;
    let maximumActiveStreams = 0;
    const modelRouter = await import("../src/model-router/model-manager.js");
    modelRouter.registerApiRouter("openai-compat", {
      async *complete(req) {
        if (!req.stream) return;
        activeStreams++;
        maximumActiveStreams = Math.max(maximumActiveStreams, activeStreams);
        try {
          await new Promise((resolve) => setTimeout(resolve, 25));
          yield { delta: "serialized reply" };
        } finally {
          activeStreams--;
        }
      },
      async completeOnce() {
        return { content: '{"will_reply": true}' };
      },
    });
    const chatModule = await import("../src/chat/chat.js");
    const chat = await chatModule.createChat([
      { role: "user", name: "user", userId: "user-1" },
      { role: "ai", name: "bot", model: "m", apiRouter: "openai-compat" },
    ]);
    const user = (await chat.getParticipants()).find((participant) => participant.role === "user")!;
    await Promise.all([
      chat.sendMessage({ chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "first" }),
      chat.sendMessage({ chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "second" }),
    ]);
    for (let i = 0; i < 100 && chat.replyingParticipants().length > 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(maximumActiveStreams).toBeLessThanOrEqual(1);
    expect(chat.replyingParticipants()).toEqual([]);
  });

  it("stops during setup before the first provider stream and drains ownership", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    let streamCalls = 0;
    const modelRouter = await import("../src/model-router/model-manager.js");
    modelRouter.registerApiRouter("openai-compat", {
      async *complete(req) {
        if (!req.stream) return;
        streamCalls++;
        yield { delta: "must not be persisted" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const chatModule = await import("../src/chat/chat.js");
    const chat = await chatModule.createChat([
      { role: "user", name: "user", userId: "user-1" },
      { role: "ai", name: "bot", model: "m", apiRouter: "openai-compat" },
    ]);
    const bot = (await chat.getParticipants()).find((participant) => participant.role === "ai")!;
    const running = chat.pingAiParticipant(bot as never);
    expect(chat.stopAiParticipant(bot.id)).toBe(true);
    await running;
    expect(chat.replyingParticipants()).toEqual([]);
    expect(streamCalls).toBe(0);
  });

  it("stops delivering generation events after a client unsubscribes", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const modelRouter = await import("../src/model-router/model-manager.js");
    modelRouter.registerApiRouter("openai-compat", {
      async *complete(req) {
        if (!req.stream) return;
        await released;
        yield { delta: "late subscriber content" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const chatModule = await import("../src/chat/chat.js");
    const chat = await chatModule.createChat([
      { role: "user", name: "user", userId: "user-1" },
      { role: "ai", name: "bot", model: "m", apiRouter: "openai-compat" },
    ]);
    const bot = (await chat.getParticipants()).find((participant) => participant.role === "ai")!;
    const packets: unknown[] = [];
    const unsubscribe = chat.subscribe((packet) => packets.push(packet));
    const running = chat.pingAiParticipant(bot as never);
    await waitForGeneration(chat);
    unsubscribe();
    release();
    await running;
    expect(packets).toEqual([]);
  });

  it("rejects writes through an evicted stale instance", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const chatModule = await import("../src/chat/chat.js");
    const chat = await chatModule.createChat([{ role: "user", name: "user", userId: "user-1" }]);
    const user = (await chat.getParticipants())[0];
    chatModule.evictChat(chat.id);
    await expect(
      chat.sendMessage({ chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "stale" }, true),
    ).rejects.toThrow("chat instance disposed");
  });

  it("shares one instance among concurrent cache loads", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const chatModule = await import("../src/chat/chat.js");
    const created = await chatModule.createChat([{ role: "user", name: "user", userId: "user-1" }]);
    chatModule.evictChat(created.id);

    const [first, second] = await Promise.all([chatModule.getChat(created.id), chatModule.getChat(created.id)]);
    expect(first).toBe(second);
  });

  it("cleans failed cache loads so a retry is not poisoned", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const chatModule = await import("../src/chat/chat.js");
    const missingChatId = "missing-chat" as never;

    await expect(chatModule.getChat(missingChatId)).rejects.toThrow();
    await expect(chatModule.getChat(missingChatId)).rejects.toThrow();
  });

  it("eviction cancels active generation ownership and prevents stale writes", async () => {
    const { migrateChatDb, getMessagesSinceId } = await import("../src/chat/database.js");
    migrateChatDb();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const modelRouter = await import("../src/model-router/model-manager.js");
    modelRouter.registerApiRouter("openai-compat", {
      async *complete(req) {
        if (!req.stream) return;
        await released;
        yield { delta: "late reply" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const chatModule = await import("../src/chat/chat.js");
    const chat = await chatModule.createChat([
      { role: "user", name: "user", userId: "user-1" },
      { role: "ai", name: "bot", model: "m", apiRouter: "openai-compat" },
    ]);
    const bot = (await chat.getParticipants()).find((participant) => participant.role === "ai")!;
    const running = chat.pingAiParticipant(bot as never);
    await waitForGeneration(chat);
    expect(chat.replyingParticipants()).toEqual([bot.id]);

    chatModule.evictChat(chat.id);
    expect(chat.replyingParticipants()).toEqual([]);
    release();
    await running;
    expect(await getMessagesSinceId(chat.id, null)).toEqual([]);
  });

  it("clearContext disposes every active generation before deleting history", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const modelRouter = await import("../src/model-router/model-manager.js");
    modelRouter.registerApiRouter("openai-compat", {
      async *complete(req) {
        if (req.stream) {
          await released;
          yield { delta: "stale" };
        }
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const chatModule = await import("../src/chat/chat.js");
    const chat = await chatModule.createChat([
      { role: "user", name: "user", userId: "user-1" },
      { role: "ai", name: "bot", model: "m", apiRouter: "openai-compat" },
    ]);
    const bot = (await chat.getParticipants()).find((participant) => participant.role === "ai")!;
    const running = chat.pingAiParticipant(bot as never);
    await waitForGeneration(chat);
    await chatModule.clearContext(chat.id);
    expect(chat.replyingParticipants()).toEqual([]);
    release();
    await running;
  });

  it("global shutdown disposal reaches every cached chat", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const releases: Array<() => void> = [];
    const modelRouter = await import("../src/model-router/model-manager.js");
    modelRouter.registerApiRouter("openai-compat", {
      async *complete(req) {
        if (!req.stream) return;
        await new Promise<void>((resolve) => releases.push(resolve));
        yield { delta: "stale" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const chatModule = await import("../src/chat/chat.js");
    const chats = await Promise.all(
      ["one", "two"].map((name) =>
        chatModule.createChat([
          { role: "user", name, userId: `user-${name}` },
          { role: "ai", name: `bot-${name}`, model: "m", apiRouter: "openai-compat" },
        ]),
      ),
    );
    const running = chats.map(async (chat) =>
      chat.pingAiParticipant((await chat.getParticipants()).find((p) => p.role === "ai") as never),
    );
    await Promise.all(chats.map((chat) => waitForGeneration(chat)));
    expect(chats.every((chat) => chat.replyingParticipants().length === 1)).toBe(true);
    chatModule.cancelAllPendingToolRequests("process shutting down");
    expect(chats.every((chat) => chat.replyingParticipants().length === 0)).toBe(true);
    for (const release of releases) release();
    await Promise.all(running);
  });
});
