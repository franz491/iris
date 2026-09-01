// tests/images-and-whisper.test.ts — image inputs to AI context + whisper
// (@mention) recipient filtering and API validation.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-img-"));
  vi.resetModules();
});

async function setupFilesProvider(): Promise<void> {
  const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
  registerInstalledProviders();
  const { kernel } = await import("../src/runtime/kernel.js");
  await kernel.setConfig([
    {
      name: "files",
      activeFunctionalities: ["create_file", "read_file"],
      additionalSettings: { rootFolder: path.join(process.env.IRIS_DATA_DIR!, "files") },
    },
  ]);
}

/** stub openai-compat router: always will_reply=true, streams a fixed reply */
async function stubReplyRouter(onContext?: (req: { context: unknown }) => void): Promise<void> {
  const mm = await import("../src/model-router/model-manager.js");
  mm.registerApiRouter("openai-compat", {
    async *complete(req) {
      if (!req.stream) {
        yield { delta: '{"will_reply": true}', finishReason: "stop" };
        return;
      }
      yield { delta: "ok" };
    },
    async completeOnce(req) {
      onContext?.({ context: req.context });
      return { content: '{"will_reply": true}' };
    },
  });
}

describe("image inputs to AI context", () => {
  it("turns uploaded image file messages into OpenAI-style image_url parts", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    await setupFilesProvider();
    const { createChat } = await import("../src/chat/chat.js");
    const { insertMessage } = await import("../src/chat/database.js");
    const { kernel } = await import("../src/runtime/kernel.js");

    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "vision-bot", model: "gemma-fast-vision" },
    ]);
    // upload path stores under chats/<chatId>/<filename>
    await kernel.useProvider("files", "create_file", {
      filename: `chats/${chat.id}/pic.png`,
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
      encoding: "base64",
    });
    const [user] = (await chat.getParticipants()).filter((p) => p.role === "user");
    await insertMessage(
      { chatId: chat.id, authorId: user.id, type: "file", thought: "", content: "[file] pic.png" },
      true,
    );

    const ai = (await chat.getParticipants()).find((p) => p.role === "ai")!;
    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const ctx = await getContextForAi(chat.id, ai as never);

    const last = ctx[ctx.length - 1];
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    const parts = last.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts.some((p) => p.type === "text" && p.text === "u1: [image] pic.png")).toBe(true);
    const img = parts.find((p) => p.type === "image_url");
    expect(img?.image_url?.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("falls back to plain text when the image file is missing", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    await setupFilesProvider();
    const { createChat } = await import("../src/chat/chat.js");
    const { insertMessage } = await import("../src/chat/database.js");

    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const [user] = (await chat.getParticipants()).filter((p) => p.role === "user");
    await insertMessage(
      { chatId: chat.id, authorId: user.id, type: "file", thought: "", content: "[file] gone.png" },
      true,
    );
    const ai = (await chat.getParticipants()).find((p) => p.role === "ai")!;
    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const ctx = await getContextForAi(chat.id, ai as never);
    const last = ctx[ctx.length - 1];
    expect(typeof last.content).toBe("string");
    expect(last.content).toBe("u1: [file] gone.png");
    // roster system message lists participants with their roles
    const roster = ctx.find((e) => e.role === "system" && String(e.content).startsWith("Participants in this chat:"));
    expect(roster).toBeDefined();
    expect(String(roster!.content)).toContain("u1 (human user)");
    expect(String(roster!.content)).toContain("bot (AI)");
    expect(String(roster!.content)).toContain("You are bot.");
  });

  it("does not turn non-image files into image_url parts", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const { insertMessage } = await import("../src/chat/database.js");

    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const [user] = (await chat.getParticipants()).filter((p) => p.role === "user");
    await insertMessage(
      { chatId: chat.id, authorId: user.id, type: "file", thought: "", content: "[file] notes.txt" },
      true,
    );
    const ai = (await chat.getParticipants()).find((p) => p.role === "ai")!;
    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const ctx = await getContextForAi(chat.id, ai as never);
    expect(typeof ctx[ctx.length - 1].content).toBe("string");
  });

  it("turns uploaded audio into llama.cpp-compatible input_audio parts", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    await setupFilesProvider();
    const { createChat } = await import("../src/chat/chat.js");
    const { insertMessage } = await import("../src/chat/database.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "audio-bot", model: "omni", apiRouter: "llamacpp" },
    ]);
    const wav = Buffer.from("RIFF-test-wave");
    await kernel.useProvider("files", "create_file", {
      filename: `chats/${chat.id}/clip.wav`,
      content: wav.toString("base64"),
      encoding: "base64",
    });
    const user = (await chat.getParticipants()).find((p) => p.role === "user")!;
    await insertMessage(
      { chatId: chat.id, authorId: user.id, type: "file", thought: "", content: "[file] clip.wav" },
      true,
    );
    const ai = (await chat.getParticipants()).find((p) => p.role === "ai")!;
    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const ctx = await getContextForAi(chat.id, ai as never);
    const parts = ctx.at(-1)!.content as { type: string; input_audio?: { data: string; format: string } }[];
    const audio = parts.find((p) => p.type === "input_audio");
    expect(audio?.input_audio).toEqual({ data: wav.toString("base64"), format: "wav" });
  });

  it("keeps audio attachments textual for routers without input-audio support", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    await setupFilesProvider();
    const { createChat } = await import("../src/chat/chat.js");
    const { insertMessage } = await import("../src/chat/database.js");
    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "text-bot", model: "m", apiRouter: "openai-compat" },
    ]);
    const user = (await chat.getParticipants()).find((p) => p.role === "user")!;
    await insertMessage(
      { chatId: chat.id, authorId: user.id, type: "file", thought: "", content: "[file] old.wav" },
      true,
    );
    const ai = (await chat.getParticipants()).find((p) => p.role === "ai")!;
    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const ctx = await getContextForAi(chat.id, ai as never);
    expect(ctx.at(-1)?.content).toBe("u1: [file] old.wav");
  });

  it("keeps batched tool results separate and pairs their call IDs by index", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const { insertMessage } = await import("../src/chat/database.js");
    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "tool-bot", model: "m" },
    ]);
    const ai = (await chat.getParticipants()).find((p) => p.role === "ai")!;
    const call = await insertMessage(
      {
        chatId: chat.id,
        authorId: ai.id,
        type: "tool",
        thought: "",
        content: JSON.stringify([
          { name: "first", arguments: "{}" },
          { name: "second", arguments: "{}" },
        ]),
      },
      true,
    );
    await insertMessage(
      {
        chatId: chat.id,
        authorId: ai.id,
        type: "tool_result",
        thought: "",
        content: JSON.stringify({ tool: "first", result: { n: 1 } }),
      },
      true,
    );
    await insertMessage(
      {
        chatId: chat.id,
        authorId: ai.id,
        type: "tool_result",
        thought: "",
        content: JSON.stringify({ tool: "second", result: { n: 2 } }),
      },
      true,
    );
    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const ctx = await getContextForAi(chat.id, ai as never);
    const calls = ctx.find((entry) => entry.role === "assistant" && entry.tool_calls)!.tool_calls as { id: string }[];
    const results = ctx.filter((entry) => entry.role === "tool");
    expect(results).toHaveLength(2);
    expect(results.map((entry) => entry.tool_call_id)).toEqual(calls.map((entry) => entry.id));
    expect(calls.map((entry) => entry.id)).toEqual([`iris-${call.id}-0`, `iris-${call.id}-1`]);
  });
});

describe("whisper recipients", () => {
  it("only pings the targeted AI when a message has .to set", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    await stubReplyRouter();
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "a", model: "m" },
      { role: "ai", name: "b", model: "m" },
    ]);
    const parts = await chat.getParticipants();
    const b = parts.find((p) => p.name === "b")!;
    const user = parts.find((p) => p.role === "user")!;

    const pinged: string[] = [];
    chat.subscribe((p) => {
      const pkt = p as { kind?: string; participantId?: string };
      if (pkt.kind === "willReply" || pkt.kind === "done") pinged.push(pkt.participantId ?? "?");
    });

    await chat.sendMessage({
      chatId: chat.id,
      authorId: user.id,
      type: "text",
      thought: "",
      content: "psst",
      to: [b.id],
    });
    for (let i = 0; i < 50 && !pinged.includes(b.id); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(pinged).toContain(b.id);
    const a = parts.find((p) => p.name === "a")!;
    expect(pinged).not.toContain(a.id);
  });

  it("AI context excludes messages whispered to another user", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    await stubReplyRouter();
    const { createChat } = await import("../src/chat/chat.js");
    const { insertMessage } = await import("../src/chat/database.js");

    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "user", name: "u2", userId: "user-2" },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const parts = await chat.getParticipants();
    const u1 = parts.find((p) => p.name === "u1")!;
    const u2 = parts.find((p) => p.name === "u2")!;

    // whisper to u2 (tagged in text as @u2; .to holds participant ids)
    await insertMessage({
      chatId: chat.id,
      authorId: u1.id,
      type: "text",
      thought: "",
      content: "@u2 secret between humans",
      to: [u2.id],
    });
    // broadcast for contrast
    await insertMessage({
      chatId: chat.id,
      authorId: u1.id,
      type: "text",
      thought: "",
      content: "hello everyone",
    });

    const ai = parts.find((p) => p.name === "bot")!;
    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const ctx = await getContextForAi(chat.id, ai as never);
    const texts = ctx.map((e) => (typeof e.content === "string" ? e.content : JSON.stringify(e.content)));
    expect(texts.some((t) => t.includes("secret between humans"))).toBe(false);
    expect(texts.some((t) => t.includes("hello everyone"))).toBe(true);
  });

  it("typed @username in text becomes a whisper while tags stay visible", async () => {
    process.env.IRIS_BETTER_AUTH_SECRET = process.env.IRIS_BETTER_AUTH_SECRET ?? "test-secret-0123456789";
    const { migrateChatDb } = await import("../src/chat/database.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    migrateChatDb();
    await stubReplyRouter();
    const { createChat } = await import("../src/chat/chat.js");
    const { api } = await import("../src/api/api.js");

    const chat = await createChat([
      { role: "user", name: "guest", userId: GUEST_USER_ID },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const ai = (await chat.getParticipants()).find((p) => p.role === "ai")!;

    let res = await api.request(`/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@Bot secret plan" }),
    });
    expect(res.status).toBe(201);
    let msgs = await chat.getMessagesSinceId("", "");
    const whisper = msgs.find((m) => m.content === "@Bot secret plan");
    expect(whisper).toBeDefined();
    expect(whisper!.to).toEqual([ai.id]);

    // unresolvable tag stays literal text and does NOT whisper
    res = await api.request(`/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "@nobody hey" }),
    });
    expect(res.status).toBe(201);
    msgs = await chat.getMessagesSinceId("", "");
    expect(msgs.some((m) => m.content === "@nobody hey" && !m.to)).toBe(true);

    // mid-text @name whispers WITHOUT being stripped from the content
    res = await api.request(`/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hey @bot come here" }),
    });
    expect(res.status).toBe(201);
    msgs = await chat.getMessagesSinceId("", "");
    const inline = msgs.find((m) => m.content === "hey @bot come here");
    expect(inline).toBeDefined();
    expect(inline!.to).toEqual([ai.id]);
  });

  it("POST /chats/:id/stop reports nothing stopped when no AI is generating", async () => {
    process.env.IRIS_BETTER_AUTH_SECRET = process.env.IRIS_BETTER_AUTH_SECRET ?? "test-secret-0123456789";
    const { migrateChatDb } = await import("../src/chat/database.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    migrateChatDb();
    await stubReplyRouter();
    const { createChat } = await import("../src/chat/chat.js");
    const { api } = await import("../src/api/api.js");

    const chat = await createChat([
      { role: "user", name: "guest", userId: GUEST_USER_ID },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const res = await api.request(`/chats/${chat.id}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: [] });
  });

  it("POST /chats/:id/messages accepts a valid whisper target and rejects unknown ones", async () => {
    process.env.IRIS_BETTER_AUTH_SECRET = process.env.IRIS_BETTER_AUTH_SECRET ?? "test-secret-0123456789";
    const { migrateChatDb } = await import("../src/chat/database.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    migrateChatDb();
    await stubReplyRouter();
    const { createChat } = await import("../src/chat/chat.js");
    const { api } = await import("../src/api/api.js");

    // guest-accessible chat (only guest user participant + one AI)
    const chat = await createChat([
      { role: "user", name: "guest", userId: GUEST_USER_ID },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const ai = (await chat.getParticipants()).find((p) => p.role === "ai")!;

    const post = (body: unknown) =>
      api.request(`/chats/${chat.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // valid whisper target
    let res = await post({ content: "hello", to: [ai.id] });
    expect(res.status).toBe(201);
    const msgs = await chat.getMessagesSinceId("", "");
    expect(msgs.some((m) => m.content === "hello" && Array.isArray(m.to) && m.to[0] === ai.id)).toBe(true);

    // unknown target -> validation error
    res = await post({ content: "hi", to: ["no-such-participant"] });
    expect(res.status).toBe(400);

    // malformed target -> validation error
    res = await post({ content: "hi", to: "bot" });
    expect(res.status).toBe(400);
  });
});

describe("stop button", () => {
  it("stop saves the truncated reply with *<interrupted>* and does NOT restart", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    let firstChunkYielded = false;
    mm.registerApiRouter("openai-compat", {
      async *complete(req) {
        if (!req.stream) {
          yield { delta: '{"will_reply": true}', finishReason: "stop" };
          return;
        }
        if (calls++ === 0) {
          firstChunkYielded = true;
          yield { delta: "partial " };
          await gate;
        } else {
          yield { delta: "restarted ok" };
        }
      },
      async completeOnce() {
        return { content: '{"will_reply": true}' };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");

    const chat = await createChat([
      { role: "user", name: "guest", userId: "user-1" },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const ai = (await chat.getParticipants()).find((p) => p.role === "ai")!;
    const user = (await chat.getParticipants()).find((p) => p.role === "user")!;

    // Raw tokens are buffered until their audience is finalized, so wait for
    // the generation lifecycle rather than an unsafe pre-routing stream event.
    await chat.sendMessage({ chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "go" });
    for (let i = 0; i < 100 && !firstChunkYielded; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(firstChunkYielded).toBe(true);
    expect(chat.stopAiParticipant(ai.id)).toBe(true);
    release();
    // give any (unwanted) restart a chance to show up
    await new Promise((r) => setTimeout(r, 300));

    const msgs = await chat.getMessagesSinceId("", "");
    const aiMsgs = msgs.filter((m) => m.authorId === ai.id);
    // routing no longer splits on blank lines; the suffix stays in one message
    expect(aiMsgs.some((m) => m.content.trim().startsWith("partial"))).toBe(true);
    expect(aiMsgs.some((m) => m.content.includes("*<interrupted>*"))).toBe(true);
    // no restart: the second stub reply must never be generated
    expect(aiMsgs.some((m) => m.content === "restarted ok")).toBe(false);
    expect(chat.replyingParticipants().length).toBe(0);
  });
});

describe("whisper readability + author prefixes", () => {
  it("AI->AI whispers are readable by all humans but not other AIs; human whispers stay private", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { canReadMessage } = await import("../src/chat/ai-participants.js");
    const roleOf = (id: string) =>
      (id.startsWith("u") ? "user" : id.startsWith("a") ? "ai" : undefined) as "user" | "ai" | undefined;

    // broadcast
    expect(canReadMessage({ to: undefined, authorId: "a1", type: "text" }, null, roleOf)).toBe(true);
    // AI -> AI whisper
    const aiToAi = { to: ["a2"], authorId: "a1", type: "text" as const };
    expect(canReadMessage(aiToAi, "a2", roleOf)).toBe(true); // recipient AI
    expect(canReadMessage(aiToAi, "a3", roleOf)).toBe(false); // other AI
    expect(canReadMessage(aiToAi, "u1", roleOf)).toBe(true); // any human
    expect(canReadMessage(aiToAi, null, roleOf)).toBe(true); // human (no id needed)
    // AI -> human whisper
    const aiToHuman = { to: ["u2"], authorId: "a1", type: "text" as const };
    expect(canReadMessage(aiToHuman, "u2", roleOf)).toBe(true);
    expect(canReadMessage(aiToHuman, "u3", roleOf)).toBe(false); // other human NOT included
    expect(canReadMessage(aiToHuman, "a2", roleOf)).toBe(false);
    // human -> AI whisper
    const humanToAi = { to: ["a1"], authorId: "u1", type: "text" as const };
    expect(canReadMessage(humanToAi, "a1", roleOf)).toBe(true);
    expect(canReadMessage(humanToAi, "u2", roleOf)).toBe(false);
    // sender always reads their own whisper
    expect(canReadMessage(humanToAi, "u1", roleOf)).toBe(true);
  });

  it("AI turns are prefixed with the AI's name so other AIs can @tag it", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    await stubReplyRouter();
    const { createChat } = await import("../src/chat/chat.js");
    const { insertMessage } = await import("../src/chat/database.js");

    const chat = await createChat([
      { role: "user", name: "u1", userId: "user-1" },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const parts = await chat.getParticipants();
    const bot = parts.find((p) => p.name === "bot")!;
    await insertMessage({ chatId: chat.id, authorId: bot.id, type: "text", thought: "", content: "hello all" });

    const { getContextForAi } = await import("../src/chat/ai-participants.js");
    const ctx = await getContextForAi(chat.id, bot as never);
    const turn = ctx.find((e) => e.role === "assistant");
    expect(turn).toBeDefined();
    expect(turn!.content).toContain("bot: hello all");
  });
});

describe("stop with no output", () => {
  it("stop during thinking still persists the *<interrupted>* marker", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const mm = await import("../src/model-router/model-manager.js");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    mm.registerApiRouter("openai-compat", {
      // stream that only THINKS, never emits text before the gate
      async *complete(req) {
        if (!req.stream) {
          yield { delta: '{"will_reply": true}', finishReason: "stop" };
          return;
        }
        yield { thoughtDelta: "pondering..." };
        await gate;
      },
      async completeOnce() {
        return { content: '{"will_reply": true}' };
      },
    });
    const { createChat } = await import("../src/chat/chat.js");

    const chat = await createChat([
      { role: "user", name: "guest", userId: "user-1" },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const parts = await chat.getParticipants();
    const ai = parts.find((p) => p.role === "ai")!;
    const user = parts.find((p) => p.role === "user")!;

    await chat.sendMessage({ chatId: chat.id, authorId: user.id, type: "text", thought: "", content: "go" });
    for (let i = 0; i < 100 && !chat.replyingParticipants().includes(ai.id); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(chat.stopAiParticipant(ai.id)).toBe(true);
    release();
    for (let i = 0; i < 100 && chat.replyingParticipants().length > 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const msgs = await chat.getMessagesSinceId("", "");
    const aiMsgs = msgs.filter((m) => m.authorId === ai.id);
    expect(aiMsgs).toHaveLength(1);
    expect(aiMsgs[0].content.trim()).toBe("- *<interrupted>*");
    // thought present only when some thinking already streamed before the stop
  });
});
