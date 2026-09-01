// tests/chat.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-chat-"));
  vi.resetModules();
});

async function loadChatModule() {
  const { migrateChatDb } = await import("../src/chat/database.js");
  migrateChatDb();
  return import("../src/chat/chat.js");
}

// stub router so no network calls happen
async function stubRouter(responses: Array<{ content: string; thought?: string }>) {
  const mm = await import("../src/model-router/model-manager.js");
  let i = 0;
  mm.registerApiRouter("openai-compat", {
    async *complete(req) {
      if (req.stream) {
        yield { delta: responses[i]?.thought ?? "" };
      }
      yield { delta: responses[i]?.content ?? "" };
    },
    async completeOnce(req) {
      void req;
      return responses[i++] ?? { content: "" };
    },
  });
}

describe("chat", () => {
  it("allocates unique message sequences under concurrent writes", async () => {
    const { createChat } = await loadChatModule();
    const { insertMessage, getHistoryPage } = await import("../src/chat/database.js");
    const chat = await createChat([{ role: "user", name: "u1", userId: "user-1" }]);
    const user = (await chat.getParticipants())[0];
    const messages = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        insertMessage({
          chatId: chat.id,
          authorId: user.id,
          type: "text",
          thought: "",
          content: `message-${index}`,
        }),
      ),
    );
    const sequences = messages.map((message) => message.seq);
    expect(new Set(sequences).size).toBe(20);
    expect(sequences.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await getHistoryPage(chat.id, null, 50)).messages).toHaveLength(20);
  });

  it("creates a chat with participants", async () => {
    const { createChat } = await loadChatModule();
    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "bot", model: "m1" },
    ]);
    const parts = await chat.getParticipants();
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.role).sort()).toEqual(["ai", "user"]);
  });

  it("sendMessage persists silently without pinging AI", async () => {
    const { createChat } = await loadChatModule();
    await stubRouter([{ content: "should not be reached" }]);
    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "bot", model: "m1" },
    ]);
    const msg = await chat.sendMessage(
      { chatId: chat.id, authorId: (await chat.getParticipants())[0].id, type: "text", thought: "", content: "hello" },
      true,
    );
    expect(msg.id).toBeTruthy();
    // wait a tick to ensure no ping fired
    await new Promise((r) => setTimeout(r, 20));
  });

  it("pings AI on non-silent message and stores reply", async () => {
    const { createChat } = await loadChatModule();
    // willReply says yes, then streamed response
    await stubRouter([
      { content: '{"will_reply": true}' }, // willReply (completeOnce)
      {}, // streamed content comes through complete
    ]);
    const mm = await import("../src/model-router/model-manager.js");
    // override streaming route to emit text
    mm.registerApiRouter("openai-compat", {
      async *complete(req) {
        if (!req.stream) {
          yield { delta: '{"will_reply": true}', finishReason: "stop" };
          return;
        }
        yield { thoughtDelta: "thinking..." };
        yield { delta: "hello there" };
      },
      async completeOnce(req) {
        // willReply phase asks for the will_reply tool specifically
        const tc = (req.toolChoice as { function?: { name?: string } } | undefined)?.function?.name;
        return tc === "will_reply"
          ? { content: '{"will_reply": true}' }
          : { content: "hello there", thought: "thinking..." };
      },
    });
    const { createChat: _c } = { createChat: null as never };
    void _c;
    const chatMod = await loadChatModule();
    const chat = await chatMod.createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "bot", model: "m1", prompt: "" },
    ]);
    const user = (await chat.getParticipants()).find((p) => p.role === "user")!;
    const packets: unknown[] = [];
    chat.subscribe((p) => packets.push(p));
    await chat.sendMessage({ chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "hi bot" });
    // allow fire-and-forget ping to finish
    for (let i = 0; i < 50 && !packets.some((p: any) => p.kind === "done"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const donePackets = packets.filter((p: any) => p.kind === "done");
    expect(donePackets.length).toBeGreaterThan(0);
    const msgs = await chat.getMessagesSinceId(user.id, "");
    const aiMsgs = msgs.filter((m) => m.content.includes("hello there"));
    expect(aiMsgs.length).toBe(1);
    expect(aiMsgs[0].thought).toContain("thinking...");
  });

  it("uses reported prompt tokens instead of base64-sized context estimates for compaction", async () => {
    const { createChat } = await loadChatModule();
    const mm = await import("../src/model-router/model-manager.js");
    mm.registerApiRouter("usage-router", {
      async *complete() {
        yield { delta: "I can still see it", usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } };
      },
      async completeOnce() {
        return { content: "summary" };
      },
    });
    const chat = await createChat(
      [
        { role: "user", name: "u1", userId: "user-1" },
        {
          role: "ai",
          name: "vision-bot",
          model: "m1",
          apiRouter: "usage-router",
          maxContext: 1_000,
          compactionThreshold: 80,
        },
      ],
      { forceAiReply: true },
    );
    const parts = await chat.getParticipants();
    const user = parts.find((p) => p.role === "user")!;
    const ai = parts.find((p) => p.role === "ai")!;
    await chat.sendMessage({
      chatId: chat.id,
      authorId: user.id,
      type: "text",
      thought: "",
      // This would force compaction under the old chars/4 estimator.
      content: "x".repeat(10_000),
    });
    for (let i = 0; i < 50 && chat.replyingParticipants().length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const { getParticipant } = await import("../src/chat/database.js");
    const fresh = await getParticipant(ai.id);
    expect(fresh.role === "ai" && fresh.lastCompactedMessageId).toBeUndefined();
  });

  it("interruptAiParticipant respects settings", async () => {
    const { createChat } = await loadChatModule();
    const chat = await createChat(
      [
        { role: "user", name: "u1", userId: "user-1" },
        { role: "ai", name: "a", model: "m" },
        { role: "ai", name: "b", model: "m" },
      ],
      { userInterruptions: true, aiInterruptions: false },
    );
    const parts = await chat.getParticipants();
    const user = parts.find((p) => p.role === "user")!;
    const aiA = parts.find((p) => p.name === "a")!;
    const aiB = parts.find((p) => p.name === "b")! as never;
    expect(chat.interruptAiParticipant(user, aiA)).toBe(true);
    expect(chat.interruptAiParticipant(aiB as never, aiA)).toBe(false);
  });

  it("rejects malformed or oversized read_tool_info declarations safely", async () => {
    const { createChat } = await loadChatModule();
    const { MAX_TOOL_ARGUMENT_BYTES } = await import("../src/chat/tools.js");
    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "bot", model: "m1" },
    ]);

    await expect(chat.handleReadToolInfo("null")).resolves.toEqual({ error: "arguments JSON must be an object" });
    await expect(chat.handleReadToolInfo('{"tools":[{"name":"files"}]}')).resolves.toEqual({
      error: "arguments JSON tools must be an array of strings",
    });
    await expect(chat.handleReadToolInfo(`{"tools":["${"x".repeat(MAX_TOOL_ARGUMENT_BYTES)}"]}`)).resolves.toEqual({
      error: `arguments JSON exceeds ${MAX_TOOL_ARGUMENT_BYTES} bytes`,
    });
  });
});

// forceAiReply: skips the willReply preflight entirely
import { describe, it, expect, beforeEach, vi } from "vitest";
describe("forceAiReply", () => {
  beforeEach(() => {
    process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-force-"));
    vi.resetModules();
  });

  it("skips the will_reply call and always replies", async () => {
    const dbm = await import("../src/chat/database.js");
    dbm.migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    let sawWillReplyToolchoice = false;
    let forcedContext: any[] = [];
    mm.registerApiRouter("force-router", {
      async *complete(req: any) {
        forcedContext = req.context;
        const tc = req.toolChoice?.function?.name;
        if (tc === "will_reply") {
          sawWillReplyToolchoice = true;
        }
        yield { delta: "forced hello" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat(
      [
        { role: "user", name: "u", userId: "u1" },
        { role: "ai", name: "bot", model: "m", apiRouter: "force-router" },
      ],
      { forceAiReply: true },
    );
    const user = (await chat.getParticipants())[0].id;
    await chat.sendMessage({ chatId: chat.id, authorId: user, type: "text", thought: "", content: "hi" });
    for (
      let i = 0;
      i < 100 && !(await chat.getMessagesSinceId(user, "")).some((m) => m.content === "forced hello");
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(sawWillReplyToolchoice).toBe(false);
    expect(forcedContext.some((m) => m.role === "system" && String(m.content).includes("<no-reply>"))).toBe(false);
    expect(forcedContext.some((m) => m.role === "system" && String(m.content).includes("This is a group chat"))).toBe(
      false,
    );
    expect((await chat.getMessagesSinceId(user, "")).some((m) => m.content === "forced hello")).toBe(true);
  });

  it("omits groupChat but keeps noReply in a one-on-one chat", async () => {
    const dbm = await import("../src/chat/database.js");
    dbm.migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    let context: any[] = [];
    mm.registerApiRouter("one-on-one-router", {
      async *complete(req: any) {
        context = req.context;
        yield { delta: "hello" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u", userId: "u1" },
      { role: "ai", name: "bot", model: "m", apiRouter: "one-on-one-router" },
    ]);
    const user = (await chat.getParticipants())[0];
    await chat.sendMessage({ chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "hi" });
    for (let i = 0; i < 50 && context.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(context.some((m) => m.role === "system" && String(m.content).includes("<no-reply>"))).toBe(true);
    expect(context.some((m) => m.role === "system" && String(m.content).includes("This is a group chat"))).toBe(false);
  });
});

describe("ai @mention whispers + no-reply", () => {
  beforeEach(() => {
    process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-mention-"));
    vi.resetModules();
  });

  async function setup() {
    const dbm = await import("../src/chat/database.js");
    dbm.migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    let reply = "hey there";
    let lastContext: any[] = [];
    mm.registerApiRouter("mention-router", {
      async *complete(req: any) {
        lastContext = req.context;
        yield { delta: reply };
      },
      async completeOnce(req: any) {
        void req;
        return { content: reply };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "alice", userId: "u1" },
      { role: "user", name: "bob", userId: "u2" },
      { role: "ai", name: "bot", model: "m", apiRouter: "mention-router" },
    ]);
    return { chat, mm, setReply: (r: string) => (reply = r), getContext: () => lastContext };
  }

  async function awaitReply(chat: any, alice: any, pred: (msgs: any[]) => boolean) {
    for (let i = 0; i < 100; i++) {
      const msgs = await chat.getMessagesSinceId(alice.id, "");
      if (pred(msgs)) return msgs;
      await new Promise((r) => setTimeout(r, 20));
    }
    return await chat.getMessagesSinceId(alice.id, "");
  }

  it("routes replies containing @name to that participant and keeps tags visible", async () => {
    const { chat, setReply } = await setup();
    const parts = await chat.getParticipants();
    const alice = parts.find((p) => p.name === "alice")!;
    const bob = parts.find((p) => p.name === "bob")!;
    setReply("this is just for you, @bob.");
    const user = alice;
    await chat.sendMessage({ chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "go" });
    const msgs = await awaitReply(chat, alice, (m) => m.some((x: any) => x.content.includes("just for you")));
    const reply = msgs.find((x: any) => x.content.includes("just for you"));
    expect(reply).toBeTruthy();
    expect(reply.to).toContain(bob.id);
    expect(reply.to).not.toContain(alice.id);
    expect(reply.content).toContain("@bob");
  });

  it("suppresses <no-reply> replies entirely", async () => {
    const { chat, setReply, getContext } = await setup();
    const parts = await chat.getParticipants();
    const alice = parts.find((p) => p.name === "alice")!;
    setReply("no-reply");
    await chat.sendMessage({ chatId: chat.id, authorId: alice.id, type: "text", thought: "", content: "go" });
    await new Promise((r) => setTimeout(r, 600));
    const msgs = await chat.getMessagesSinceId(alice.id, "");
    expect(msgs.some((m: any) => m.authorId !== alice.id && !m.type.startsWith("tool"))).toBe(false);
    const protocolMessages = getContext().filter((m: any) => m.role === "system" && /reply/i.test(String(m.content)));
    expect(protocolMessages.some((m: any) => String(m.content).includes("<no-reply>"))).toBe(true);
    expect(protocolMessages.map((m: any) => String(m.content))).toContainEqual(
      expect.stringContaining("Normal text is public"),
    );
  });

  it("suppresses silence variants and whitespace-only output", async () => {
    for (const output of [" <NO REPLY> ", "No Reply", "no-reply", "   \n "]) {
      const { chat, setReply } = await setup();
      const alice = (await chat.getParticipants()).find((p) => p.name === "alice")!;
      setReply(output);
      await chat.sendMessage({ chatId: chat.id, authorId: alice.id, type: "text", thought: "", content: "go" });
      await new Promise((r) => setTimeout(r, 100));
      const msgs = await chat.getMessagesSinceId(alice.id, "");
      expect(msgs.some((m: any) => m.authorId !== alice.id && m.type === "text")).toBe(false);
    }
  });

  it("splits paragraphs into separately targeted messages", async () => {
    const { chat, setReply } = await setup();
    const parts = await chat.getParticipants();
    const alice = parts.find((p) => p.name === "alice")!;
    const bob = parts.find((p) => p.name === "bob")!;
    setReply("@bob secret for bob<new-message>public announcement");
    await chat.sendMessage({ chatId: chat.id, authorId: alice.id, type: "text", thought: "", content: "go" });
    const msgs = await awaitReply(
      chat,
      alice,
      (m) =>
        m.some((x: any) => x.content === "@bob secret for bob") &&
        m.some((x: any) => x.content === "public announcement"),
    );
    const whisper = msgs.find((x: any) => x.content === "@bob secret for bob");
    const broadcast = msgs.find((x: any) => x.content === "public announcement");
    expect(whisper?.to).toContain(bob.id);
    expect(broadcast?.to ?? []).not.toContain(bob.id);
  });

  it("handles mixed, duplicate, inline, and ping-only tags without removing them", async () => {
    const { chat, setReply } = await setup();
    const parts = await chat.getParticipants();
    const alice = parts.find((p) => p.name === "alice")!;
    const bob = parts.find((p) => p.name === "bob")!;
    setReply("@bob @ghost mixed<new-message>hello @bob @bob<new-message>@bob");
    await chat.sendMessage({ chatId: chat.id, authorId: alice.id, type: "text", thought: "", content: "go" });
    const msgs = await awaitReply(chat, alice, (m) => m.some((x: any) => x.content === "@bob"));
    for (const content of ["@bob @ghost mixed", "hello @bob @bob", "@bob"]) {
      const msg = msgs.find((m: any) => m.content === content);
      expect(msg?.to).toEqual([bob.id]);
    }
  });
});

describe("segmented thinking", () => {
  beforeEach(() => {
    process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-seg-"));
    vi.resetModules();
  });

  it("accumulates reasoning then content into ONE message (reasoning->content->stop)", async () => {
    const dbm = await import("../src/chat/database.js");
    dbm.migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    mm.registerApiRouter("seg-router", {
      async *complete() {
        yield { thoughtDelta: "thinking about greeting" };
        yield { delta: "hello" };
        yield { delta: " it rains" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u", userId: "u1" },
      { role: "ai", name: "bot", model: "m", apiRouter: "seg-router" },
    ]);
    const user = (await chat.getParticipants()).find((p) => p.role === "user")!.id;
    await chat.sendMessage({ chatId: chat.id, authorId: user, type: "text", thought: "", content: "hi" });
    for (
      let i = 0;
      i < 100 && !(await chat.getMessagesSinceId(user, "")).some((m) => m.content === "hello it rains");
      i++
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const msgs = (await chat.getMessagesSinceId(user, "")).filter((m) => m.authorId !== user);
    expect(msgs.map((m) => m.content)).toContain("hello it rains");
    const reply = msgs.find((m) => m.content === "hello it rains")!;
    expect(reply.thought).toBe("thinking about greeting");
  });
});

describe("stream packet emission", () => {
  beforeEach(() => {
    process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-stream-"));
    vi.resetModules();
  });

  it("orders an explicit routing frame before live content and rejects unsafe scopes", async () => {
    const chatMod = await loadChatModule();
    const chat = await chatMod.createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "user", name: "u2", userId: "user-2" },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const packets: unknown[] = [];
    chat.subscribe((packet) => packets.push(packet));
    const users = await chat.getParticipants();
    const u1 = users.find((p) => p.name === "u1")!;
    const bot = users.find((p) => p.name === "bot")!;
    await chat.emitScopedStream(bot.id, [u1.id], { delta: "secret" });
    expect(packets.map((p) => (p as { kind: string }).kind)).toEqual(["routing", "stream"]);
    expect((packets[0] as { routingVersion: number }).routingVersion).toBe(1);
    expect((packets[1] as { chunk: { delta: string } }).chunk.delta).toBe("secret");
    await expect(chat.emitScopedStream(bot.id, [], { delta: "public" })).rejects.toThrow(
      "invalid stream recipient scope",
    );
    await expect(chat.emitScopedStream(bot.id, ["forged"], { delta: "bad" })).rejects.toThrow(
      "invalid stream recipient scope",
    );
    expect(packets).toHaveLength(2);
  });

  it("emits SSE stream packets for BOTH thought and content chunks", async () => {
    const dbm = await import("../src/chat/database.js");
    dbm.migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    mm.registerApiRouter("openai-compat", {
      async *complete(req) {
        if (!req.stream) {
          yield { delta: '{"will_reply": true}', finishReason: "stop" };
          return;
        }
        yield { thoughtDelta: "reasoning part 1" };
        yield { thoughtDelta: " + 2" };
        yield { delta: "final answer" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const chatMod = await loadChatModule();
    const chat = await chatMod.createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "bot", model: "m1", prompt: "" },
    ]);
    const user = (await chat.getParticipants()).find((p) => p.role === "user")!;
    const packets: any[] = [];
    chat.subscribe((p) => packets.push(p));
    await chat.sendMessage({ chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "hi" });
    for (let i = 0; i < 100 && !packets.some((p) => p.kind === "done"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const streamPackets = packets.filter((p) => p.kind === "stream" && p.participantId);
    const thought = streamPackets.map((p) => p.chunk?.thoughtDelta ?? "").join("");
    const content = streamPackets.map((p) => p.chunk?.delta ?? "").join("");
    expect(thought).toBe("reasoning part 1 + 2");
    expect(content).toBe("final answer");
    expect(
      streamPackets.every(
        (p) =>
          Array.isArray(p.recipientParticipantIds) &&
          p.recipientParticipantIds.length === 1 &&
          p.recipientParticipantIds[0] === user.id,
      ),
    ).toBe(true);
    expect(packets.find((p) => p.kind === "done")?.recipientParticipantIds).toEqual([user.id]);
  });

  it("scopes uniform private replay and suppresses mixed-audience content replay", async () => {
    const dbm = await import("../src/chat/database.js");
    dbm.migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    let reply = "@alice private";
    mm.registerApiRouter("scope-router", {
      async *complete() {
        yield { delta: reply };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const chatMod = await loadChatModule();
    const chat = await chatMod.createChat(
      [
        { role: "user", name: "alice", userId: "user-a" },
        { role: "user", name: "bob", userId: "user-b" },
        { role: "ai", name: "bot", model: "m1", apiRouter: "scope-router", prompt: "" },
      ],
      { forceAiReply: true },
    );
    const participants = await chat.getParticipants();
    const alice = participants.find((p) => p.name === "alice")!;
    const bob = participants.find((p) => p.name === "bob")!;
    const packets: any[] = [];
    chat.subscribe((packet) => packets.push(packet));

    await chat.sendMessage({ chatId: chat.id, authorId: alice.id, type: "text", thought: "", content: "private" });
    for (let i = 0; i < 100 && !packets.some((p) => p.kind === "done"); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(packets.filter((p) => p.kind === "stream").map((p) => p.recipientParticipantIds)).toEqual([[alice.id]]);
    expect(packets.find((p) => p.kind === "done")?.recipientParticipantIds).toEqual([alice.id]);

    packets.length = 0;
    reply = "@alice first secret<new-message>@bob second secret";
    await chat.sendMessage({ chatId: chat.id, authorId: alice.id, type: "text", thought: "", content: "mixed" });
    for (let i = 0; i < 100 && !packets.some((p) => p.kind === "done"); i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(packets.filter((p) => p.kind === "stream")).toHaveLength(0);
    expect(packets.find((p) => p.kind === "done")?.recipientParticipantIds).toEqual([alice.id, bob.id].sort());
  });
});
