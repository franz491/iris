// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  pollMessages: vi.fn(),
  getHistoryPage: vi.fn(),
  getParticipants: vi.fn(),
  getChatSettings: vi.fn(),
  getCompaction: vi.fn(),
  pollChats: vi.fn(),
  listAiCards: vi.fn(),
  pushToolConfig: vi.fn(),
};
const closeStream = vi.fn();
const authClient = { signOut: vi.fn() };

vi.mock("../src/lib/api", () => ({ api, authClient, subscribeToChat: () => closeStream }));
vi.mock("../src/lib/tools", () => ({
  advertisedToolConfig: () => ({ tools: [] }),
  getClientId: () => "client",
}));
vi.mock("../src/lib/backend", () => ({ apiUrl: (path: string) => path }));
vi.mock("../src/lib/backend-probe", () => ({ probeBackend: vi.fn() }));
vi.mock("../src/lib/toasts.svelte", () => ({ pushToast: vi.fn() }));
vi.mock("../src/lib/log", () => ({ log: vi.fn() }));

const { AppState } = await import("../src/lib/state.svelte");

const message = (chatId: string, id: string) => ({
  id,
  chatId,
  authorId: "author",
  type: "text" as const,
  thought: "",
  content: id,
  createdAt: "now",
});

beforeEach(() => {
  vi.clearAllMocks();
  api.pollMessages.mockResolvedValue({ messages: [] });
  api.getHistoryPage.mockResolvedValue({ messages: [], hasMore: false });
  api.getParticipants.mockResolvedValue({ participants: [] });
  api.getChatSettings.mockResolvedValue({ userInterruptions: true, aiInterruptions: false });
  api.getCompaction.mockResolvedValue({ progress: {} });
  api.pollChats.mockResolvedValue({ chats: [] });
  api.listAiCards.mockResolvedValue({ cards: [] });
  authClient.signOut.mockResolvedValue(undefined);
});

describe("AppState chat lifecycle", () => {
  it("does not let a stale openChat overwrite the newer chat", async () => {
    let resolveOld!: (value: { messages: ReturnType<typeof message>[] }) => void;
    const oldLoad = new Promise<{ messages: ReturnType<typeof message>[] }>((resolve) => {
      resolveOld = resolve;
    });
    api.pollMessages.mockImplementation((chatId: string) =>
      chatId === "old" ? oldLoad : Promise.resolve({ messages: [message("new", "new-message")] }),
    );

    const state = new AppState();
    const oldOpen = state.openChat("old");
    await state.openChat("new");
    resolveOld({ messages: [message("old", "stale-message")] });
    await oldOpen;

    expect(state.currentChatId).toBe("new");
    expect(state.messages.map((item) => item.id)).toEqual(["new-message"]);
  });

  it("does not let an older chat refresh overwrite a newer refresh", async () => {
    let resolveOld!: (value: { chats: never[] }) => void;
    const oldRefresh = new Promise<{ chats: never[] }>((resolve) => {
      resolveOld = resolve;
    });
    api.pollChats
      .mockImplementationOnce(() => oldRefresh)
      .mockResolvedValueOnce({
        chats: [{ id: "new", createdAt: "now" }],
      });

    const state = new AppState();
    const firstRefresh = state.refreshChats();
    await state.refreshChats();
    resolveOld({ chats: [] });
    await firstRefresh;

    expect(state.chats.map((chat) => chat.id)).toEqual(["new"]);
  });

  it("closes the stream and clears chat-scoped state on logout", async () => {
    const state = new AppState();
    state.currentChatId = "chat";
    state.messages = [message("chat", "message")];
    state.participants = [{ id: "p", chatId: "chat", role: "ai", name: "AI", createdAt: "now" }];
    state.replying = new Set(["p"]);
    state.live = { participantId: "p", thought: "thought", content: "content" };
    state.pendingToolRequests = [
      {
        requestId: "request",
        tool: "tool",
        arguments: {},
        requiresApproval: true,
        chatId: "chat",
      },
    ];
    await state.openChat("chat");
    closeStream.mockClear();

    await state.logout();

    expect(closeStream).toHaveBeenCalledOnce();
    expect(state.currentChatId).toBeNull();
    expect(state.messages).toEqual([]);
    expect(state.participants).toEqual([]);
    expect(state.replying.size).toBe(0);
    expect(state.live).toBeNull();
    expect(state.pendingToolRequests).toEqual([]);
    expect(api.pollChats).not.toHaveBeenCalled();
    expect(api.listAiCards).not.toHaveBeenCalled();
  });

  it("does not let a compaction response repopulate state after logout", async () => {
    let resolveCompaction!: (value: { progress: Record<string, number> }) => void;
    const pendingCompaction = new Promise<{ progress: Record<string, number> }>((resolve) => {
      resolveCompaction = resolve;
    });
    api.getCompaction.mockReturnValueOnce(pendingCompaction);

    const state = new AppState();
    state.currentChatId = "chat";
    const refresh = state.refreshCompaction();

    await state.logout();
    resolveCompaction({ progress: { p: 75 } });
    await refresh;

    expect(state.compaction).toEqual({});
  });
});

describe("persisted UI layout", () => {
  it("falls back when persisted UI state is not an object", async () => {
    localStorage.setItem("iris.ui", "null");
    vi.resetModules();

    const { app } = await import("../src/lib/state.svelte");

    expect(app.leftOpen).toBe(true);
    expect(app.rightOpen).toBe(false);
    expect(app.bottomOpen).toBe(false);
  });

  it("preserves valid preferences while falling back malformed values", async () => {
    localStorage.setItem("iris.ui", JSON.stringify({ leftOpen: "yes", rightOpen: true, bottomOpen: false }));
    vi.resetModules();

    const { app } = await import("../src/lib/state.svelte");

    expect(app.leftOpen).toBe(true);
    expect(app.rightOpen).toBe(true);
    expect(app.bottomOpen).toBe(false);
  });
});
