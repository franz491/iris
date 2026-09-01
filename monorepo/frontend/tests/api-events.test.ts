// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, parseChatEvent, subscribeToChat } from "../src/lib/api";
import { isBootstrapStatus } from "../src/lib/schema";

const message = {
  id: "message-1",
  chatId: "chat-1",
  authorId: "participant-1",
  type: "text" as const,
  thought: "",
  content: "hello",
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("parseChatEvent", () => {
  it("accepts only non-empty versioned routing preambles", () => {
    expect(
      parseChatEvent({ kind: "routing", participantId: "p1", routingVersion: 1, recipientParticipantIds: ["u1"] }),
    ).toEqual({ kind: "routing", participantId: "p1", routingVersion: 1, recipientParticipantIds: ["u1"] });
    expect(
      parseChatEvent({ kind: "routing", participantId: "p1", routingVersion: 1, recipientParticipantIds: [] }),
    ).toBeNull();
    expect(
      parseChatEvent({ kind: "routing", participantId: "p1", routingVersion: 2, recipientParticipantIds: ["u1"] }),
    ).toBeNull();
  });
  it("narrows valid event payloads to their discriminated shapes", () => {
    expect(parseChatEvent({ kind: "message", message })).toEqual({ kind: "message", message });
    expect(parseChatEvent({ kind: "stream", participantId: "p1", chunk: { delta: "hi" } })).toEqual({
      kind: "stream",
      participantId: "p1",
      chunk: { delta: "hi" },
    });
    expect(
      parseChatEvent({
        kind: "tool_request",
        requestId: "r1",
        tool: "fe_files",
        arguments: {},
        requiresApproval: true,
      }),
    ).toMatchObject({ kind: "tool_request", requestId: "r1", tool: "fe_files", requiresApproval: true });
  });

  it.each([
    undefined,
    null,
    [],
    { kind: "not-an-event" },
    { kind: "message", message: { ...message, content: 42 } },
    { kind: "stream", participantId: "p1", chunk: { delta: 42 } },
    { kind: "done", participantId: 42 },
    { kind: "audio_ready", token: "" },
    { kind: "truncated" },
    { kind: "tool_request", requestId: "r1", tool: "fe_files", requiresApproval: "yes" },
  ])("rejects unknown or malformed payload %#", (event) => {
    expect(parseChatEvent(event)).toBeNull();
  });

  it("does not accept a stream with no text delta", () => {
    expect(parseChatEvent({ kind: "stream", participantId: "p1", chunk: {} })).toBeNull();
  });

  it.each([-1, 1.5, Infinity, NaN])("rejects an invalid branch rewrite count: %s", (deletedFollowing) => {
    expect(parseChatEvent({ kind: "branch_rewritten", message, deletedFollowing })).toBeNull();
  });

  it("accepts a non-negative integer branch rewrite count", () => {
    expect(parseChatEvent({ kind: "branch_rewritten", message, deletedFollowing: 0 })).toEqual({
      kind: "branch_rewritten",
      message,
      deletedFollowing: 0,
    });
  });
});

describe("compaction API responses", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("accepts numeric progress", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ progress: { p1: 0.5 } }))));
    await expect(api.getCompaction("chat-1")).resolves.toEqual({ progress: { p1: 0.5 } });
  });
  it("rejects malformed and server-error responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ progress: { p1: "bad" } }))));
    await expect(api.getCompaction("chat-1")).rejects.toThrow("Invalid API response");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503 })));
    await expect(api.getCompaction("chat-1")).rejects.toThrow("503");
  });
});

describe("bootstrap status response contract", () => {
  it("accepts valid configured status for redirect decisions", () => {
    expect(isBootstrapStatus({ configured: false })).toBe(true);
    expect(isBootstrapStatus({ configured: true })).toBe(true);
  });
  it("rejects malformed status payloads without trusting redirect state", () => {
    expect(isBootstrapStatus({ configured: "false" })).toBe(false);
    expect(isBootstrapStatus({})).toBe(false);
    expect(isBootstrapStatus(null)).toBe(false);
  });
  it("treats an HTTP error as unavailable rather than a valid status", () => {
    expect(isBootstrapStatus({ error: "forbidden", status: 403 })).toBe(false);
  });
});

describe("api.getSetupInfo", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the validated default model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            defaultModel: { apiRouter: "llamacpp", model: "local", maxContext: 4096 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    await expect(api.getSetupInfo()).resolves.toEqual({
      defaultModel: { apiRouter: "llamacpp", model: "local", maxContext: 4096 },
    });
  });

  it.each([
    { defaultModel: { apiRouter: "llamacpp", model: "local", maxContext: 0 } },
    { defaultModel: { apiRouter: "llamacpp", model: 42, maxContext: 4096 } },
    { unexpected: true },
  ])("rejects malformed response %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    await expect(api.getSetupInfo()).rejects.toThrow("Invalid API response");
  });
});

describe("model discovery API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates routers and models", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ routers: ["llamacpp"] }), { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ models: [{ id: "local", contextWindow: 4096 }] }), { status: 200 }),
        ),
    );
    await expect(api.listModelRouters()).resolves.toEqual({ routers: ["llamacpp"] });
    await expect(api.listModels()).resolves.toEqual({ models: [{ id: "local", contextWindow: 4096 }] });
  });

  it.each([
    ["routers", { routers: [42] }, () => api.listModelRouters()],
    ["models", { models: [{ id: "local", contextWindow: 0 }] }, () => api.listModels()],
    ["models missing id", { models: [{ contextWindow: 4096 }] }, () => api.listModels()],
  ])("rejects malformed %s response", async (_name, body, call) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    await expect(call()).rejects.toThrow("Invalid API response");
  });
});

describe("AI-card API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates card listings", async () => {
    const card = {
      id: "c1",
      name: "Local",
      model: "m",
      apiRouter: "llamacpp",
      maxContext: 4096,
      prompt: "",
      createdAt: "2026-01-01",
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ cards: [card] }), { status: 200 })));
    await expect(api.listAiCards()).resolves.toEqual({ cards: [card] });
  });

  it.each([{ cards: [{ id: "c1", name: "Local" }] }, { cards: "invalid" }, { unexpected: true }])(
    "rejects malformed card listing %#",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
      await expect(api.listAiCards()).rejects.toThrow("Invalid API response");
    },
  );
});

describe("chat history API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates history page responses", async () => {
    const message = {
      id: "m1",
      chatId: "c1",
      authorId: "p1",
      type: "text",
      thought: "",
      content: "hello",
      createdAt: "2026-01-01",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ messages: [message], hasMore: false, oldestSeq: 1 }), { status: 200 }),
        ),
    );
    await expect(api.getHistoryPage("c1", null)).resolves.toEqual({
      messages: [message],
      hasMore: false,
      oldestSeq: 1,
    });
  });

  it.each([
    { messages: [], hasMore: "no", oldestSeq: null },
    { messages: [{ id: "m1" }], hasMore: false, oldestSeq: 1 },
    { messages: [], hasMore: false, oldestSeq: -1 },
  ])("rejects malformed history page %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    await expect(api.getHistoryPage("c1", null)).rejects.toThrow("Invalid API response");
  });
});

describe("guest chat API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates the guest chat identity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ chatId: "guest-1", name: "Guest" }), { status: 200 })),
    );
    await expect(api.getGuestChat()).resolves.toEqual({ chatId: "guest-1", name: "Guest" });
  });

  it.each([{ name: "Guest" }, { chatId: 42 }, { chatId: "guest-1", name: 42 }])(
    "rejects malformed guest chat %#",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
      await expect(api.getGuestChat()).rejects.toThrow("Invalid API response");
    },
  );
});

describe("create chat API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates the created chat id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ chatId: "chat-1" }), { status: 201 })),
    );
    await expect(api.createChat({ participants: [] })).resolves.toEqual({ chatId: "chat-1" });
  });

  it.each([{ chatId: "" }, { chatId: 42 }, { created: true }])(
    "rejects malformed creation response %#",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 201 })));
      await expect(api.createChat({ participants: [] })).rejects.toThrow("Invalid API response");
    },
  );

  it("preserves server error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "not allowed" }), { status: 403 })),
    );
    await expect(api.createChat({ participants: [] })).rejects.toThrow("not allowed");
  });
});

describe("chat settings API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("validates updated settings", async () => {
    const settings = { userInterruptions: true, aiInterruptions: false, forceAiReply: true };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(settings), { status: 200 })));
    await expect(api.updateChatSettings("c1", { forceAiReply: true })).resolves.toEqual(settings);
  });

  it.each([
    { userInterruptions: true },
    { userInterruptions: true, aiInterruptions: "no" },
    { userInterruptions: true, aiInterruptions: false, forceAiReply: 1 },
  ])("rejects malformed settings response %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    await expect(api.updateChatSettings("c1", {})).rejects.toThrow("Invalid API response");
  });

  it("preserves settings server errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })),
    );
    await expect(api.updateChatSettings("c1", {})).rejects.toThrow("forbidden");
  });
});

describe("api.pollMessages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a validated message response", async () => {
    const response = { messages: [message] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })));

    await expect(api.pollMessages("chat-1", "message-0")).resolves.toEqual(response);
  });

  it.each([{ messages: [{ ...message, content: 42 }] }, { messages: "not-an-array" }, { messages: [null] }])(
    "rejects an invalid message response %#",
    async (response) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })));

      await expect(api.pollMessages("chat-1", "message-0")).rejects.toThrow("Invalid API response");
    },
  );
});

describe("api.pollChats", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a validated chat response", async () => {
    const response = { chats: [{ id: "chat-1", createdAt: "2026-01-01T00:00:00.000Z", name: "A chat" }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })));

    await expect(api.pollChats(0)).resolves.toEqual(response);
  });

  it.each([
    { chats: [{ id: "chat-1", createdAt: 42 }] },
    { chats: [{ id: "", createdAt: "2026-01-01T00:00:00.000Z" }] },
    { chats: [{ id: "chat-1", createdAt: "2026-01-01T00:00:00.000Z", name: 42 }] },
    { chats: "not-an-array" },
    { chats: [null] },
  ])("rejects an invalid chat response %#", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 })));

    await expect(api.pollChats(0)).rejects.toThrow("Invalid API response");
  });
});

describe("subscribeToChat", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops malformed event JSON while preserving valid events", () => {
    const listeners = new Map<string, (event: MessageEvent) => void>();
    const eventSource = {
      addEventListener: (kind: string, listener: EventListener) =>
        listeners.set(kind, listener as (event: MessageEvent) => void),
      close: vi.fn(),
    };
    vi.stubGlobal(
      "EventSource",
      vi.fn(() => eventSource),
    );

    const onEvent = vi.fn();
    const close = subscribeToChat("chat-1", "client-1", onEvent);

    expect(() => listeners.get("message")?.(new MessageEvent("message", { data: "{" }))).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();

    listeners.get("message")?.(new MessageEvent("message", { data: JSON.stringify({ message }) }));
    expect(onEvent).toHaveBeenCalledWith({ kind: "message", message });

    close();
  });
});
