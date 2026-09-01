// tests/phase1.test.ts — settings persistence, guest rule, polling scope,
// named API keys, regex worker, willReply tool protocol.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-p1-"));
  process.env.IRIS_API_KEYS_MASTER_KEY = Buffer.alloc(32, 17).toString("base64");
  delete process.env.IRIS_API_KEYS_MASTER_KEY_FILE;
  vi.resetModules();
});

async function setup() {
  const dbm = await import("../src/chat/database.js");
  dbm.migrateChatDb();
  const chatMod = await import("../src/chat/chat.js");
  return { chatMod };
}

describe("chat settings persistence", () => {
  it("settings survive a fresh getChat", async () => {
    const { chatMod } = await setup();
    const chat = await chatMod.createChat([{ role: "user", name: "u", userId: "u1" }]);
    expect(chat.settings.userInterruptions).toBe(true);
    await chat.setSettings({ userInterruptions: false, aiInterruptions: true });

    // simulate server restart: fresh module instances
    vi.resetModules();
    process.env.IRIS_DATA_DIR = process.env.IRIS_DATA_DIR; // same dir
    const dbm2 = await import("../src/chat/database.js");
    void dbm2;
    const chatMod2 = await import("../src/chat/chat.js");
    const chat2 = await chatMod2.getChat(chat.id);
    expect(chat2.settings.userInterruptions).toBe(false);
    expect(chat2.settings.aiInterruptions).toBe(true);
  });

  it("fails closed when persisted loaded tools are not a bounded string array", async () => {
    const { chatMod } = await setup();
    const { chatSqlite, loadChatSettings } = await import("../src/chat/database.js");
    const chat = await chatMod.createChat([{ role: "user", name: "u", userId: "u1" }]);
    const update = chatSqlite.prepare("UPDATE chat_settings SET loaded_tools = ? WHERE chat_id = ?");

    for (const value of [
      "not-json",
      JSON.stringify({ tools: ["files"] }),
      JSON.stringify(["files", 42]),
      JSON.stringify([""]),
      JSON.stringify(["x".repeat(257)]),
      JSON.stringify(Array.from({ length: 257 }, () => "files")),
    ]) {
      update.run(value, chat.id);
      expect((await loadChatSettings(chat.id))?.loadedTools).toBeUndefined();
    }

    update.run(JSON.stringify(["x", "y".repeat(256)]), chat.id);
    expect((await loadChatSettings(chat.id))?.loadedTools).toEqual(["x", "y".repeat(256)]);
  });
});

describe("guest user rule", () => {
  it("guests access only chats without registered users", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const auth = await import("../src/chat/auth.js");
    const { createChat } = await import("../src/chat/chat.js");

    const guestChat = await createChat([]); // no user participants
    expect(await auth.isUserAuthorizedInChat(guestChat.id, auth.GUEST_USER_ID)).toBe(true);

    const userChat = await createChat([{ role: "user", name: "a", userId: "u1" }]);
    expect(await auth.isUserAuthorizedInChat(userChat.id, auth.GUEST_USER_ID)).toBe(false);
    expect(await auth.isUserAuthorizedInChat(userChat.id, "u1")).toBe(true);
    expect(await auth.isUserAuthorizedInChat(userChat.id, "u2")).toBe(false);

    // guest-participant-only chat stays guest-accessible
    const guestPartChat = await createChat([{ role: "user", name: "g", userId: auth.GUEST_USER_ID }]);
    expect(await auth.isUserAuthorizedInChat(guestPartChat.id, auth.GUEST_USER_ID)).toBe(true);
  });
});

describe("polling scoping", () => {
  it("returns chats created or joined after the timestamp for that user", async () => {
    await setup();
    const { createChat } = await import("../src/chat/chat.js");
    const { getChatsSinceTimestamp } = await import("../src/chat/polling.js");
    const t0 = Date.now();
    const old = await createChat([{ role: "user", name: "u1", userId: "u1" }]);
    await new Promise((r) => setTimeout(r, 10));
    const t1 = Date.now();
    const fresh = await createChat([
      { role: "user", name: "u1", userId: "u1" },
      { role: "user", name: "u2", userId: "u2" },
    ]);
    await new Promise((r) => setTimeout(r, 5));
    // u1 joins old chat late
    const { getParticipantsRows, insertParticipant } = await import("../src/chat/database.js");
    void getParticipantsRows;
    await insertParticipant(old.id, { role: "user", name: "late-joiner", userId: "u3" });

    const sinceT1 = await getChatsSinceTimestamp("u1", t1);
    expect(sinceT1.map((c) => c.id)).toEqual([fresh.id]);

    // u3 joined old chat after t1 -> sees it
    const u3 = await getChatsSinceTimestamp("u3", t1);
    expect(u3.map((c) => c.id)).toContain(old.id);

    const all = await getChatsSinceTimestamp("u1", t0 - 1000);
    expect(all.length).toBe(2);
  });
});

describe("named API keys", () => {
  it("stores and resolves keys by name without touching participants", async () => {
    await setup();
    const keys = await import("../src/model-router/keys.js");
    keys.setApiKey("openai-work", "sk-secret");
    expect(keys.getApiKey("openai-work")).toBe("sk-secret");
    expect(keys.listApiKeyNames()).toContain("openai-work");
    expect(keys.deleteApiKey("openai-work")).toBe(true);
    expect(keys.getApiKey("openai-work")).toBe(null);
  });

  it("fails closed for malformed persisted rows and rejects invalid writes", async () => {
    await setup();
    const keys = await import("../src/model-router/keys.js");
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const sqlite = openDb(dataFile("keys.db")).sqlite;

    sqlite
      .prepare("INSERT INTO api_keys (name, ciphertext, nonce, tag, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("malformed", "not-base64", "not-base64", "not-base64", Date.now());
    expect(() => keys.getApiKey("malformed")).toThrow(/Unable to decrypt/);
    expect(keys.listApiKeyNames()).toContain("malformed");

    expect(() => keys.setApiKey("", "secret")).toThrow();
    expect(() => keys.setApiKey("valid-name", "")).toThrow();
    expect(() => keys.setApiKey("x".repeat(257), "secret")).toThrow();
    expect(() => keys.setApiKey("valid-name", "x".repeat(4097))).toThrow();
  });

  it("model manager resolves apiKeyName into request key material", async () => {
    await setup();
    const keys = await import("../src/model-router/keys.js");
    keys.setApiKey("openrouter", "sk-or-123");
    const mm = await import("../src/model-router/model-manager.js");
    let seenKey: string | undefined;
    mm.registerApiRouter("openai-compat", {
      async *complete(req) {
        seenKey = (req.additionalFields as { _apiKey?: string })._apiKey;
        yield { delta: "" };
      },
      async completeOnce(req) {
        seenKey = (req.additionalFields as { _apiKey?: string })._apiKey;
        return { content: "" };
      },
    });
    await mm.routeCompletionOnce(
      { model: "m", apiRouter: "openai-compat", apiAdditionalFields: {}, apiKeyName: "openrouter" },
      [],
    );
    expect(seenKey).toBe("sk-or-123");
  });
});

describe("regex worker timeout", () => {
  it("matches lines and replaces with timeout protection", async () => {
    const w = await import("../src/misc/regex-worker.js");
    const matches = await w.matchLinesWithTimeout("b+", "", "a\nbb\nccc", 2000);
    expect(matches).toEqual([[2, "bb"]]);
    const replaced = await w.replaceWithTimeout("(foo)", "", "x foo y", "<$1>", 2000);
    expect(replaced).toBe("x <foo> y");
    // evil regex times out rather than hanging the loop
    const evil = "(a+)+$";
    const text = "a".repeat(30) + "!";
    await expect(w.matchLinesWithTimeout(evil, "", text, 300)).rejects.toThrow(/timed out|invalid/i);
  });
});

describe("reply protocol (<no-reply> / @tags)", () => {
  it("resolves tags anywhere, case-insensitively, without duplicates", async () => {
    const { mentionedParticipantIds } = await import("../src/chat/chat.js");
    const participants = [
      { id: "b", name: "Bob" },
      { id: "a", name: "alice" },
    ] as never;
    expect(mentionedParticipantIds("hi @BOB, @bob and @ghost", participants)).toEqual(["b"]);
    expect(mentionedParticipantIds("@alice", participants)).toEqual(["a"]);
  });
});

describe("AI cards", () => {
  it("CRUD scoped to owner", async () => {
    await setup();
    const db = await import("../src/chat/database.js");
    await db.createAiCard("u1", { name: "helper", model: "m1", prompt: "be nice" });
    const u1 = await db.listAiCards("u1");
    expect(u1).toHaveLength(1);
    expect(u1[0].name).toBe("helper");

    // other user sees nothing
    expect(await db.listAiCards("u2")).toHaveLength(0);

    // update only by owner
    const updated = await db.updateAiCard("u1", u1[0].id, { name: "helper2" });
    expect(updated?.name).toBe("helper2");
    expect(await db.updateAiCard("u2", u1[0].id, { name: "steal" })).toBeNull();

    // delete only by owner
    expect(await db.deleteAiCard("u2", u1[0].id)).toBe(false);
    expect(await db.deleteAiCard("u1", u1[0].id)).toBe(true);
    expect(await db.listAiCards("u1")).toHaveLength(0);
  });
});

describe("context turn merging", () => {
  it("folds consecutive same-role turns without touching order", async () => {
    const { mergeConsecutiveTurns } = await import("../src/chat/ai-participants.js");
    const merged = mergeConsecutiveTurns([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "assistant", content: "c" },
      { role: "assistant", content: "d" },
      { role: "user", content: "e" },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[1].content).toBe("b\n\nc\n\nd");
    expect(merged[0].role).toBe("user");
    expect(merged[2].content).toBe("e");
    // single entries untouched
    const one = mergeConsecutiveTurns([{ role: "assistant", content: "only" }]);
    expect(one).toHaveLength(1);
  });
});

describe("message branch rewriting", () => {
  it("rewrites in place and permanently deletes every later message", async () => {
    const { chatMod } = await setup();
    const chat = await chatMod.createChat([{ role: "user", name: "u", userId: "u1" }]);
    const author = (await chat.getParticipants())[0].id;
    await chat.sendMessage({ chatId: chat.id, authorId: author, type: "text", thought: "", content: "m1" }, true);
    await chat.sendMessage(
      { chatId: chat.id, authorId: author, type: "text", thought: "old thought", content: "m2" },
      true,
    );
    await chat.sendMessage({ chatId: chat.id, authorId: author, type: "text", thought: "", content: "m3" }, true);
    let msgs = await chat.getMessagesSinceId("u", "");
    expect(msgs).toHaveLength(3);

    const originalId = msgs[1].id;
    const edited = await chat.rewriteHistory(originalId, { thought: "new thought", content: "m2-edited" });
    expect(edited.message.id).toBe(originalId);
    expect(edited.deletedFollowing).toBe(1);
    msgs = await chat.getMessagesSinceId("u", "");
    const m2 = msgs.find((m) => m.content === "m2-edited");
    expect(m2?.thought).toBe("new thought");
    expect(msgs.map((m) => m.content)).toEqual(["m1", "m2-edited"]);
  });

  it("regenerates after a human edit but waits after an AI edit", async () => {
    const { chatMod } = await setup();
    const mm = await import("../src/model-router/model-manager.js");
    let replies = 0;
    mm.registerApiRouter("rewrite-router", {
      async *complete() {
        replies++;
        yield { delta: "regenerated" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const chat = await chatMod.createChat(
      [
        { role: "user", name: "u", userId: "u-rewrite" },
        { role: "ai", name: "bot", model: "m", apiRouter: "rewrite-router" },
      ],
      { forceAiReply: true },
    );
    const parts = await chat.getParticipants();
    const user = parts.find((p) => p.role === "user")!;
    const ai = parts.find((p) => p.role === "ai")!;
    const humanMessage = await chat.sendMessage(
      { chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "old question" },
      true,
    );
    await chat.sendMessage(
      { chatId: chat.id, authorId: ai.id, type: "text", thought: "", content: "old answer" },
      true,
    );
    const humanRewrite = await chat.rewriteHistory(humanMessage.id, { content: "new question" });
    expect(humanRewrite.regenerating).toBe(true);
    for (let i = 0; i < 50 && replies === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replies).toBe(1);
    for (let i = 0; i < 50 && chat.replyingParticipants().length > 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const regenerated = (await chat.getMessagesSinceId(user.id, "")).find((m) => m.content === "regenerated")!;
    const aiRewrite = await chat.rewriteHistory(regenerated.id, { content: "human-corrected AI text" });
    expect(aiRewrite.regenerating).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(replies).toBe(1);
  });

  it("addParticipant appends humans with avatar and AIs to an existing chat", async () => {
    const { chatMod } = await setup();
    const db = await import("../src/chat/database.js");
    const chat = await chatMod.createChat([
      { role: "user", name: "u", userId: "u1", avatar: "data:image/png;base64,x" },
    ]);
    const human = await db.addParticipant(chat.id, { role: "user", name: "u2", userId: "u2", avatar: "data:x" });
    expect(human.role).toBe("user");
    expect((human as never as { avatar?: string }).avatar).toBe("data:x");
    const ai = await db.addParticipant(chat.id, { role: "ai", name: "late-ai", model: "m9", prompt: "p" });
    expect(ai.role).toBe("ai");
    const parts = await chat.getParticipants();
    expect(parts).toHaveLength(3);
  });
});

describe("AI tool loop", () => {
  it("executes provider tools and returns the final answer", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    const root = mkdtempSync(path.join(tmpdir(), "iris-tools-"));
    await kernel.setConfig([
      { name: "files", activeFunctionalities: ["create_file", "read_file"], additionalSettings: { rootFolder: root } },
      { name: "shell", activeFunctionalities: [], additionalSettings: {} },
    ]);

    // stub router: iteration 1 asks to create a file; iteration 2 answers
    const mm = await import("../src/model-router/model-manager.js");
    let calls = 0;
    mm.registerApiRouter("test-router-1", {
      async *complete() {
        calls++;
        if (calls === 1) {
          yield {
            toolCallDeltas: [
              {
                index: 0,
                id: "c1",
                name: "backend_create_file",
                arguments: '{"filename":"made.txt","content":"by ai"}',
              },
            ],
            finishReason: "tool_calls",
          };
          return;
        }
        yield { delta: "done, file created" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });

    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u", userId: "u1" },
      { role: "ai", name: "bot", model: "m", apiRouter: "test-router-1" },
    ]);
    await chat.setLoadedGroups(["files"]);
    const user1 = (await chat.getParticipants())[0].id;
    await chat.sendMessage({ chatId: chat.id, authorId: user1, type: "text", thought: "", content: "make a file" });
    for (
      let i = 0;
      i < 200 && !(await chat.getMessagesSinceId(user1, "")).some((m) => m.content === "done, file created");
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const msgs = await chat.getMessagesSinceId(user1, "");
    expect(msgs.some((m) => m.type === "tool")).toBe(true);
    expect(msgs.some((m) => m.type === "tool_result")).toBe(true);
    expect(msgs.some((m) => m.content === "done, file created")).toBe(true);
    // the tool really executed through the provider
    const read = (await kernel.useProvider<{ content: string }>("files", "read_file", { filename: "made.txt" })) as {
      content: string;
    };
    expect(read.content).toBe("by ai");
  }, 20000);

  it("read_tool_info loads a group into the chat on demand", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    const root = mkdtempSync(path.join(tmpdir(), "iris-rti-"));
    await kernel.setConfig([
      { name: "files", activeFunctionalities: ["create_file"], additionalSettings: { rootFolder: root } },
    ]);

    const mm = await import("../src/model-router/model-manager.js");
    let calls = 0;
    mm.registerApiRouter("test-router-rti", {
      async *complete(req) {
        calls++;
        if (calls === 1) {
          // no groups loaded yet: model discovers via read_tool_info
          yield {
            toolCallDeltas: [{ index: 0, id: "c1", name: "read_tool_info", arguments: '{"tools":["backend_files"]}' }],
            finishReason: "tool_calls",
          };
          return;
        }
        if (calls === 2) {
          // now files functions must be available in the tools list
          const names =
            (req.tools as { function?: { name?: string } }[] | undefined)?.map((t) => t.function?.name) ?? [];
          expect(names).toContain("backend_create_file");
          yield {
            toolCallDeltas: [
              {
                index: 0,
                id: "c2",
                name: "backend_create_file",
                arguments: '{"filename":"loaded.txt","content":"on demand"}',
              },
            ],
            finishReason: "tool_calls",
          };
          return;
        }
        yield { delta: "loaded and created" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });

    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u", userId: "u2" },
      { role: "ai", name: "bot", model: "m", apiRouter: "test-router-rti" },
    ]);
    const readToolInfo = vi.spyOn(chat, "handleReadToolInfo");
    const user = (await chat.getParticipants())[0].id;
    await chat.sendMessage({
      chatId: chat.id,
      authorId: user,
      type: "text",
      thought: "",
      content: "load files and make a file",
    });
    for (
      let i = 0;
      i < 200 && !(await chat.getMessagesSinceId(user, "")).some((m) => m.content === "loaded and created");
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await chat.getMessagesSinceId(user, "")).some((m) => m.content === "loaded and created")).toBe(true);
    expect(readToolInfo).toHaveBeenCalledTimes(1);
    // loading persisted with the chat settings
    expect(chat.settings.loadedTools).toContain("files");
    // a tool_result message carried the loaded docs
    const msgs = await chat.getMessagesSinceId(user, "");
    const rti = msgs.find(
      (m) =>
        m.type === "tool_result" &&
        m.content.includes("tool.md") === false &&
        m.content.includes("sandboxed file access"),
    );
    expect(rti || msgs.some((m) => m.type === "tool_result" && m.content.toLowerCase().includes("files"))).toBeTruthy();
  }, 20000);

  it("read_tool_info resolves local/backend aliases, deduplicates, and reports unknown names", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u", userId: "u-rti" },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const result = (await chat.handleReadToolInfo(
      JSON.stringify({
        tools: ["files", "files", "backend_files", "not_a_tool"],
      }),
    )) as { loaded: string[]; unknownTools?: string[]; docs: Record<string, { functions: Record<string, string> }> };
    expect(result.loaded).toEqual(expect.arrayContaining(["fe_files", "files", "memory", "read_tool_info"]));
    expect(result.unknownTools).toEqual(["not_a_tool"]);
    expect(result.docs.fe_files.functions.read_file).toContain("Example");
    expect(result.docs.files.functions.read_file).toContain("Example");
    expect(chat.settings.loadedTools?.filter((g) => g === "fe_files")).toHaveLength(1);
    expect(chat.settings.loadedTools?.filter((g) => g === "files")).toHaveLength(1);
  });

  it("frontend tools round-trip through approval requests with timeout", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    let n = 0;
    mm.registerApiRouter("test-router-2", {
      async *complete() {
        n++;
        if (n === 1) {
          yield {
            toolCallDeltas: [{ index: 0, id: "c1", name: "shell_exec", arguments: '{"command":"echo test"}' }],
            finishReason: "tool_calls",
          };
          return;
        }
        yield { delta: "search said hi" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u", userId: "u1" },
      { role: "ai", name: "bot", model: "m", apiRouter: "test-router-2" },
    ]);
    chat.setToolConfig("u1", "client-1", {
      tools: [{ tool: "fe_shell", requiresApproval: true, approvalTimeoutMs: 300 }],
    });

    let capturedRequest: Record<string, unknown> | null = null;
    chat.subscribe((p) => {
      if ((p as { kind?: string }).kind === "tool_request") capturedRequest = p as Record<string, unknown>;
    });

    const user = (await chat.getParticipants())[0].id;
    await chat.sendMessage({ chatId: chat.id, authorId: user, type: "text", thought: "", content: "search something" });
    for (let i = 0; i < 50 && !capturedRequest; i++) await new Promise((r) => setTimeout(r, 20));
    expect(capturedRequest).toBeTruthy();
    const requestId = (capturedRequest as { requestId: string }).requestId;

    // approve with a result
    expect(
      chat.resolveToolRequest(
        requestId,
        { userId: "u1", clientId: "client-1" },
        { approved: true, result: [{ title: "hi" }] },
      ),
    ).toBe(true);
    for (
      let i = 0;
      i < 200 && !(await chat.getMessagesSinceId(user, "")).some((m) => m.content === "search said hi");
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect((await chat.getMessagesSinceId(user, "")).some((m) => m.content === "search said hi")).toBe(true);
  }, 20000);

  it("frontend tool times out when not approved", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    let n = 0;
    mm.registerApiRouter("test-router-3", {
      async *complete() {
        n++;
        if (n === 1) {
          yield {
            toolCallDeltas: [{ index: 0, id: "c1", name: "shell_exec", arguments: "{}" }],
            finishReason: "tool_calls",
          };
          return;
        }
        yield { delta: "gave up politely" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u", userId: "u1" },
      { role: "ai", name: "bot", model: "m", apiRouter: "test-router-3" },
    ]);
    chat.setToolConfig("u1", "client-1", { tools: [{ tool: "fe_shell", approvalTimeoutMs: 150 }] });
    const user = (await chat.getParticipants())[0].id;
    await chat.sendMessage({ chatId: chat.id, authorId: user, type: "text", thought: "", content: "go" });
    for (
      let i = 0;
      i < 300 && !(await chat.getMessagesSinceId(user, "")).some((m) => m.content === "gave up politely");
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const msgs = await chat.getMessagesSinceId(user, "");
    const resultMsg = [...msgs].reverse().find((m) => m.type === "tool_result");
    expect(resultMsg?.content).toContain("timed out");
    expect(msgs.some((m) => m.content === "gave up politely")).toBe(true);
  }, 20000);

  it("cancels a frontend tool wait on stop and rejects a late response", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    mm.registerApiRouter("cancel-wait-router", {
      async *complete() {
        yield {
          toolCallDeltas: [{ index: 0, id: "cancel-1", name: "shell_exec", arguments: "{}" }],
          finishReason: "tool_calls",
        };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u", userId: "cancel-user" },
      { role: "ai", name: "bot", model: "m", apiRouter: "cancel-wait-router" },
    ]);
    chat.setToolConfig("cancel-user", "cancel-client", {
      tools: [{ tool: "fe_shell", approvalTimeoutMs: 5_000 }],
    });
    let requestId: string | undefined;
    chat.subscribe((packet) => {
      if ((packet as { kind?: string }).kind === "tool_request") {
        requestId = (packet as { requestId: string }).requestId;
      }
    });
    const user = (await chat.getParticipants())[0].id;
    await chat.sendMessage({ chatId: chat.id, authorId: user, type: "text", thought: "", content: "go" });
    for (let i = 0; i < 100 && !requestId; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requestId).toBeDefined();
    const ai = (await chat.getParticipants()).find((participant) => participant.role === "ai")!;
    expect(chat.stopAiParticipant(ai.id)).toBe(true);
    expect(
      chat.resolveToolRequest(requestId!, { userId: "cancel-user", clientId: "cancel-client" }, { approved: true }),
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const messages = await chat.getMessagesSinceId(user, "");
    expect(messages.some((message) => message.type === "tool_result")).toBe(false);
    expect(messages.some((message) => message.content === "- *<interrupted>*")).toBe(true);
    expect(chat.replyingParticipants()).toEqual([]);
  }, 20000);

  it("cancels a frontend tool wait when history is rewritten", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    let calls = 0;
    mm.registerApiRouter("rewrite-wait-router", {
      async *complete() {
        calls++;
        if (calls === 1) {
          yield {
            toolCallDeltas: [{ index: 0, id: "rewrite-1", name: "shell_exec", arguments: "{}" }],
            finishReason: "tool_calls",
          };
          return;
        }
        yield { delta: "rewritten reply" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u", userId: "rewrite-user" },
      { role: "ai", name: "bot", model: "m", apiRouter: "rewrite-wait-router" },
    ]);
    chat.setToolConfig("rewrite-user", "rewrite-client", {
      tools: [{ tool: "fe_shell", approvalTimeoutMs: 5_000 }],
    });
    let requestId: string | undefined;
    chat.subscribe((packet) => {
      if ((packet as { kind?: string }).kind === "tool_request" && !requestId)
        requestId = (packet as { requestId: string }).requestId;
    });
    const user = (await chat.getParticipants())[0].id;
    const original = await chat.sendMessage({
      chatId: chat.id,
      authorId: user,
      type: "text",
      thought: "",
      content: "original",
    });
    for (let i = 0; i < 100 && !requestId; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(requestId).toBeDefined();
    await chat.rewriteHistory(original.id, { content: "rewritten" });
    expect(
      chat.resolveToolRequest(requestId!, { userId: "rewrite-user", clientId: "rewrite-client" }, { approved: true }),
    ).toBe(false);
    for (let i = 0; i < 100; i++) {
      if ((await chat.getMessagesSinceId(user, "")).some((message) => message.content === "rewritten reply")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const messages = await chat.getMessagesSinceId(user, "");
    expect(messages.some((message) => message.type === "tool_result")).toBe(false);
    expect(messages.some((message) => message.content === "rewritten reply")).toBe(true);
    expect(chat.replyingParticipants()).toEqual([]);
  }, 20000);

  it("requires target_user for multi-human local tools and accepts only the targeted client", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    let turn = 0;
    mm.registerApiRouter("target-router", {
      async *complete() {
        turn++;
        if (turn === 1) {
          yield {
            toolCallDeltas: [{ index: 0, name: "shell_exec", arguments: '{"command":"pwd"}' }],
            finishReason: "tool_calls",
          };
        } else if (turn === 2) {
          yield {
            toolCallDeltas: [{ index: 0, name: "shell_exec", arguments: '{"command":"pwd","target_user":"bob"}' }],
            finishReason: "tool_calls",
          };
        } else {
          yield { delta: "used bob's machine" };
        }
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "alice", userId: "alice-id" },
      { role: "user", name: "bob", userId: "bob-id" },
      { role: "ai", name: "bot", model: "m", apiRouter: "target-router" },
    ]);
    chat.setToolConfig("alice-id", "alice-desktop", { tools: [{ tool: "fe_shell", requiresApproval: true }] });
    chat.setToolConfig("bob-id", "bob-desktop", { tools: [{ tool: "fe_shell", requiresApproval: true }] });
    let request: Record<string, unknown> | null = null;
    chat.subscribe((packet) => {
      if ((packet as { kind?: string }).kind === "tool_request") request = packet as Record<string, unknown>;
    });
    const alice = (await chat.getParticipants()).find((p) => p.name === "alice")!;
    await chat.sendMessage({ chatId: chat.id, authorId: alice.id, type: "text", thought: "", content: "run it" });
    for (let i = 0; i < 50 && !request; i++) await new Promise((resolve) => setTimeout(resolve, 20));

    expect(request?.targetUserId).toBe("bob-id");
    expect(request?.targetClientId).toBe("bob-desktop");
    const requestId = String(request?.requestId);
    expect(
      chat.resolveToolRequest(requestId, { userId: "alice-id", clientId: "alice-desktop" }, { approved: true }),
    ).toBe(false);
    expect(
      chat.resolveToolRequest(
        requestId,
        { userId: "bob-id", clientId: "bob-desktop" },
        { approved: true, result: { stdout: "/project" } },
      ),
    ).toBe(true);
  }, 20000);
});
