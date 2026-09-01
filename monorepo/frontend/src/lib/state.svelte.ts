// lib/state.svelte.ts — app state (Svelte 5 runes).
import { api, authClient, subscribeToChat, type ChatEvent } from "./api";
import { apiUrl } from "./backend";
import { advertisedToolConfig, getClientId } from "./tools";
import { BackendLifecycle, type BackendStatus } from "./backend-lifecycle";
import { pushToast } from "./toasts.svelte";
import { log } from "./log";
import type { ChatSummary, Message, Participant, ChatSettings } from "./types";

export type SessionInfo = { kind: "loading" } | { kind: "guest" } | { kind: "user"; name: string };

export class AppState {
  session = $state<SessionInfo>({ kind: "loading" });
  chats = $state<ChatSummary[]>([]);
  currentChatId = $state<string | null>(null);
  messages = $state<Message[]>([]);
  participants = $state<Participant[]>([]);
  settings = $state<ChatSettings>({ userInterruptions: true, aiInterruptions: false });
  /** participant ids currently generating a reply */
  replying = $state<Set<string>>(new Set());
  /** live streaming buffer of the AI currently generating */
  live = $state<{ participantId: string; thought: string; content: string } | null>(null);
  /** @names mentioned so far in the live buffer (whisper heuristic) */
  liveMentions = $state<Set<string>>(new Set());
  /** persisted UI layout (panels open/closed), localStorage-backed */
  leftOpen = $state(uiPref("leftOpen", true));
  rightOpen = $state(uiPref("rightOpen", false));
  bottomOpen = $state(uiPref("bottomOpen", false));
  showLogin = $state(false);
  showNewChat = $state(false);
  showNewAiCard = $state(false);
  showSettings = $state(false);
  showToolSettings = $state(false);
  isAdmin = $state(false);
  toolSettingsFocus = $state<string | null>(null);
  readonly clientId = getClientId();

  get currentChat(): ChatSummary | null {
    return this.chats.find((c) => c.id === this.currentChatId) ?? null;
  }

  participantName(id: string): string {
    return this.participants.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  }

  /**
   * Should the live streaming preview be visible to me? Hidden once the
   * streamed text contains an @tag that is not my name; shown again if a
   * later @tag matches me (multi-paragraph replies target different people).
   */
  canSeeLive(): boolean {
    if (!this.live) return false;
    if (this.liveMentions.size === 0) return true;
    const me = this.participants.find((p) => p.role === "user" && p.userId === this.myId)?.name;
    return !!me && this.liveMentions.has(me.toLowerCase());
  }

  /**
   * May I (the local human user) read this message? Whisper rules:
   * broadcasts and compaction entries are public; sender + recipients always
   * read their whispers; AI->AI whispers are also visible to all humans;
   * whispers involving a human are sender/recipients only. (History and
   * polling are already filtered server-side; this covers live SSE.)
   */
  canRead(m: Pick<Message, "to" | "authorId" | "type">): boolean {
    const roleOf = (id: string) => this.participants.find((p) => p.id === id)?.role;
    const me = this.participants.find((p) => p.role === "user" && p.userId === this.myId)?.id ?? null;
    if (!m.to || m.to.length === 0 || m.type === "compaction") return true;
    if (me !== null && (m.to.includes(me) || m.authorId === me)) return true;
    const recipientsAllAi = m.to.every((id) => roleOf(id) === "ai");
    return roleOf(m.authorId) === "ai" && recipientsAllAi;
  }

  isGuest(): boolean {
    return this.session.kind !== "user";
  }

  async init(): Promise<void> {
    this.session = { kind: "loading" };
    this.guestChatFailed = false;
    await this.checkBackend();
    if (!this.backendOnline) {
      this.session = { kind: "guest" }; // so the offline UI (not "loading…") shows
      return;
    }
    try {
      const session = await authClient.getSession();
      if (session.data?.user) {
        this.session = { kind: "user", name: session.data.user.name };
        this.myId = session.data.user.id;
        this.myImage = session.data.user.image ?? null;
        this.isAdmin = (session.data.user as { role?: string }).role === "admin";
      } else {
        this.session = { kind: "guest" };
        this.isAdmin = false;
      }
    } catch {
      this.session = { kind: "guest" };
      this.isAdmin = false;
    }
    await this.refreshChats().catch(() => {});
    await this.refreshAiCards().catch(() => {});
    void this.refreshCompaction();
    if (this.isGuest()) {
      // guests get the universal shared chat instead of creating their own
      try {
        const { chatId, name } = await api.getGuestChat();
        this.guestChatFailed = false;
        this.guestChatId = chatId;
        // make it visible in the sidebar (polling excludes guests by design)
        if (!this.chats.some((c) => c.id === chatId)) {
          this.chats = [...this.chats, { id: chatId, createdAt: new Date().toISOString(), name: name ?? "guest chat" }];
        }
        if (!this.currentChatId) await this.openChat(chatId);
      } catch (e) {
        console.error("failed to load guest chat", e);
        this.guestChatFailed = true;
        pushToast("warn", "could not load the guest chat");
      }
      return;
    }
    if (this.chats.length > 0 && !this.currentChatId) {
      await this.openChat(this.chats[this.chats.length - 1].id);
    }
  }

  guestChatId = $state<string | null>(null);
  guestChatFailed = $state(false);
  hasMoreHistory = $state(false);
  loadingOlder = $state(false);
  aiCards = $state<import("./types").AiCard[]>([]);
  compaction = $state<Record<string, number>>({});
  myId = $state<string | null>(null);
  myImage = $state<string | null>(null);
  backendOnline = $state(true);
  backendStatus = $state<BackendStatus>("starting");
  private backendLifecycle = new BackendLifecycle();
  /** FE-executed tools awaiting user approval / execution */
  pendingToolRequests = $state<
    { requestId: string; tool: string; arguments: unknown; requiresApproval: boolean; chatId: string }[]
  >([]);

  /** Monotonically increasing token invalidates in-flight chat loads. */
  private chatLoadGeneration = 0;
  private chatsRefreshGeneration = 0;
  private aiCardsRefreshGeneration = 0;

  async refreshCompaction(): Promise<void> {
    const chatId = this.currentChatId;
    if (!chatId) return;
    const generation = this.chatLoadGeneration;
    try {
      const r = await api.getCompaction(chatId);
      if (generation !== this.chatLoadGeneration || chatId !== this.currentChatId) return;
      this.compaction = r.progress;
    } catch {
      /* ignore */
    }
  }

  async compactNow(participantId: string): Promise<void> {
    if (!this.currentChatId) return;
    await api.compactAi(this.currentChatId, participantId);
    await this.refreshCompaction();
    pushToast("info", "context compacted");
  }

  async refreshAiCards(): Promise<void> {
    const generation = ++this.aiCardsRefreshGeneration;
    if (this.isGuest()) {
      this.aiCards = [];
      return;
    }
    const cards = await api
      .listAiCards()
      .then((r) => r.cards)
      .catch(() => []);
    if (generation === this.aiCardsRefreshGeneration && !this.isGuest()) this.aiCards = cards;
  }

  async saveAiCard(card: {
    name: string;
    model?: string;
    apiRouter?: string;
    maxContext?: number;
    prompt?: string;
  }): Promise<void> {
    await api.createAiCard(card);
    await this.refreshAiCards();
  }

  async removeAiCard(id: string): Promise<void> {
    await api.deleteAiCard(id);
    await this.refreshAiCards();
  }

  async updateAiCard(
    id: string,
    patch: {
      name?: string;
      model?: string;
      apiRouter?: string;
      maxContext?: number;
      prompt?: string;
      avatar?: string | null;
      propagate?: boolean;
    },
  ): Promise<void> {
    await api.updateAiCard(id, patch);
    await this.refreshAiCards();
  }

  /** Re-push the effective tool config (called after editing settings). */
  async pushToolConfigNow(chatId: string): Promise<void> {
    try {
      await api.pushToolConfig(chatId, this.clientId, advertisedToolConfig(chatId, this.myId ?? "guest"));
    } catch (e) {
      console.error("failed to push tool config", e);
    }
  }

  async answerToolRequest(requestId: string, approved: boolean, result?: unknown, error?: string): Promise<void> {
    const req = this.pendingToolRequests.find((r) => r.requestId === requestId);
    if (!req) return;
    await api.respondToolRequest(req.chatId, { requestId, clientId: this.clientId, approved, result, error });
    this.pendingToolRequests = this.pendingToolRequests.filter((r) => r.requestId !== requestId);
  }

  async addParticipant(body: {
    role: "user" | "ai";
    name: string;
    model?: string;
    apiRouter?: string;
    maxContext?: number;
    prompt?: string;
  }): Promise<void> {
    if (!this.currentChatId) return;
    await api.addParticipant(this.currentChatId, body);
    await this.openChat(this.currentChatId); // refresh participants
  }

  async editMessage(messageId: string, patch: { content?: string; thought?: string }): Promise<void> {
    if (!this.currentChatId) return;
    const result = await api.editMessage(this.currentChatId, messageId, patch);
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) this.messages = [...this.messages.slice(0, idx), result.message];
    this.live = null;
    this.replying = new Set();
  }

  async refreshHasMore(chatId: string, generation = this.chatLoadGeneration): Promise<void> {
    try {
      const page = await api.getHistoryPage(chatId, null, 1);
      if (generation !== this.chatLoadGeneration || chatId !== this.currentChatId) return;
      const known = new Set(this.messages.map((m) => m.id));
      this.hasMoreHistory = page.messages.some((m) => !known.has(m.id)) || page.hasMore;
    } catch {
      if (generation === this.chatLoadGeneration && chatId === this.currentChatId) this.hasMoreHistory = false;
    }
  }

  async loadOlder(): Promise<void> {
    if (!this.currentChatId || this.loadingOlder || this.messages.length === 0) return;
    this.loadingOlder = true;
    try {
      const page = await api.getHistoryPage(this.currentChatId, this.oldestCursor(), 50);
      const fresh = page.messages.filter((m) => !this.messages.some((x) => x.id === m.id));
      this.messages = [...fresh, ...this.messages];
      this.hasMoreHistory = page.hasMore;
    } finally {
      this.loadingOlder = false;
    }
  }

  private oldestCursor(): number | null {
    for (const m of this.messages) {
      if (m.seq !== undefined && m.seq !== null) return m.seq;
    }
    return null;
  }

  async clearCurrentContext(): Promise<void> {
    if (!this.currentChatId) return;
    await api.clearContext(this.currentChatId);
    await this.openChat(this.currentChatId); // reload empty history
  }

  async refreshChats(): Promise<void> {
    const generation = ++this.chatsRefreshGeneration;
    try {
      // "since 0" = all my chats (created or joined)
      const res = await api.pollChats(0);
      if (generation !== this.chatsRefreshGeneration) return;
      this.chats = res.chats;
    } catch (e) {
      console.error("failed to load chats", e);
    }
  }

  private closeStream: (() => void) | null = null;
  private audioPlayers = new Set<HTMLAudioElement>();

  private async playTransientAudio(token: string): Promise<void> {
    const player = new Audio();
    player.crossOrigin = "use-credentials";
    player.src = api.transientAudioUrl(token);
    this.audioPlayers.add(player);
    const cleanup = () => {
      this.audioPlayers.delete(player);
      player.removeAttribute("src");
      player.load();
    };
    player.addEventListener("ended", cleanup, { once: true });
    player.addEventListener("error", cleanup, { once: true });
    try {
      await player.play();
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  async openChat(chatId: string): Promise<void> {
    const generation = ++this.chatLoadGeneration;
    this.closeStream?.();
    this.closeStream = null;
    this.currentChatId = chatId;
    this.messages = [];
    this.participants = [];
    this.replying = new Set();
    this.live = null;

    // seed history via polling from empty id
    try {
      const res = await api.pollMessages(chatId, seedId(chatId));
      if (generation !== this.chatLoadGeneration || chatId !== this.currentChatId) return;
      this.messages = res.messages;
    } catch (e) {
      console.error("failed to load messages", e);
    }
    if (generation !== this.chatLoadGeneration || chatId !== this.currentChatId) return;
    await this.refreshHasMore(chatId, generation);
    if (generation !== this.chatLoadGeneration || chatId !== this.currentChatId) return;

    this.participants = await api
      .getParticipants(chatId)
      .then((r) => r.participants)
      .catch(() => []);
    if (generation !== this.chatLoadGeneration || chatId !== this.currentChatId) return;
    this.settings = await api.getChatSettings(chatId).catch(() => this.settings);
    if (generation !== this.chatLoadGeneration || chatId !== this.currentChatId) return;

    this.closeStream = subscribeToChat(chatId, this.clientId, (event) => this.onChatEvent(chatId, event), {
      onReconnect: () => {
        pushToast("info", "connection restored");
        void this.pushToolConfigNow(chatId);
        void this.pollLatest();
      },
      onDisconnect: () => {
        pushToast("warn", "connection lost — retrying…", 4000);
        this.live = null;
        void this.checkBackend();
      },
    });

    // push this machine's effective tool config for the connection
    try {
      await api.pushToolConfig(chatId, this.clientId, advertisedToolConfig(chatId, this.myId ?? "guest"));
    } catch (e) {
      console.error("failed to push tool config", e);
    }
  }

  private onChatEvent(chatId: string, event: ChatEvent): void {
    log("debug", "sse", chatId.slice(0, 8), event.kind, event);
    if (chatId !== this.currentChatId) return;
    const { kind } = event;
    if (kind === "compacting") {
      const who = event.name ?? "an AI";
      pushToast("info", `${who} is compacting their context…`, 4000);
      return;
    }
    if (kind === "compacted") {
      pushToast("info", `${event.name ?? "context"} compacted`, 3000);
      return;
    }
    if (kind === "message") {
      const incoming = event.message;
      // Tool messages are emitted immediately after the streamed reasoning
      // that led to them. Preserve that reasoning even if the persistence
      // event did not include it (for example, with an older backend).
      const msg =
        incoming?.type === "tool" &&
        !incoming.thought &&
        this.live?.participantId === incoming.authorId &&
        this.live.thought
          ? { ...incoming, thought: this.live.thought }
          : incoming;
      if (msg && !this.messages.some((m) => m.id === msg.id) && this.canRead(msg)) {
        this.messages = [...this.messages, msg];
      }
      // the streamed generation just landed; drop the live buffer
      if (this.live?.participantId === msg.authorId) this.live = null;
      // author finished replying once their message lands
      const next = new Set(this.replying);
      next.delete(msg.authorId);
      this.replying = next;
    } else if (kind === "stream") {
      const pid = event.participantId;
      this.replying = new Set([...this.replying, pid]);
      const chunk = event.chunk;
      if (!this.live || this.live.participantId !== pid) {
        this.live = { participantId: pid, thought: "", content: "" };
        this.liveMentions = new Set();
      }
      if (chunk?.thoughtDelta) this.live.thought += chunk.thoughtDelta;
      if (chunk?.delta) this.live.content += chunk.delta;
      // whisper heuristic: track @tags written so far in the live text
      this.liveMentions = new Set(
        [...this.live.content.matchAll(/@([^\s@<>]+)/g)].map((m) => m[1].toLowerCase().replace(/[.,!?;:]+$/, "")),
      );
      // keep the object identity changing so runes notice
      this.live = { ...this.live };
    } else if (kind === "deleted") {
      // chat was deleted elsewhere; drop it and move on
      this.closeStream?.();
      this.closeStream = null;
      this.chats = this.chats.filter((c) => c.id !== chatId);
      if (this.currentChatId === chatId) {
        this.currentChatId = null;
        this.messages = [];
        this.participants = [];
        if (this.chats.length > 0) void this.openChat(this.chats[this.chats.length - 1].id);
      }
    } else if (kind === "tool_request") {
      if (event.targetUserId !== (this.myId ?? "guest") || event.targetClientId !== this.clientId) return;
      this.pendingToolRequests = [
        ...this.pendingToolRequests,
        {
          requestId: event.requestId,
          tool: event.tool,
          arguments: event.arguments,
          requiresApproval: event.requiresApproval,
          chatId,
        },
      ];
    } else if (kind === "audio_ready") {
      void this.playTransientAudio(event.token).catch((error) => {
        console.error("automatic audio playback failed", error);
        pushToast("warn", "audio was generated, but automatic playback was blocked");
      });
    } else if (kind === "branch_rewritten") {
      const rewritten = event.message;
      const idx = this.messages.findIndex((m) => m.id === rewritten.id);
      if (idx >= 0) this.messages = [...this.messages.slice(0, idx), rewritten];
      this.live = null;
      this.replying = new Set();
    } else if (kind === "truncated") {
      if (chatId !== this.currentChatId) return;
      const from = event.fromMessageId;
      const idx = this.messages.findIndex((m) => m.id === from);
      if (idx >= 0) this.messages = this.messages.slice(0, idx);
      this.live = null;
      this.replying = new Set();
    } else if (kind === "done") {
      const pid = event.participantId;
      const next = new Set(this.replying);
      next.delete(pid);
      this.replying = next;
    }
  }

  /** Toggle whether an AI sees other AIs' reasoning blocks. */
  async setReadsOthersThoughts(participantId: string, value: boolean): Promise<void> {
    if (!this.currentChatId) return;
    await api.updateAiParticipant(this.currentChatId, participantId, { readsOthersThoughts: value });
    this.participants = this.participants.map((p) =>
      p.id === participantId ? { ...p, readsOthersThoughts: value } : p,
    );
  }

  /** Stop the AI currently generating (or all of them). */
  async stopReplying(participantId?: string): Promise<void> {
    if (!this.currentChatId) return;
    try {
      await api.stopAi(this.currentChatId, participantId);
    } finally {
      // optimistic local cleanup; "done" SSE confirms server-side
      if (participantId) {
        const next = new Set(this.replying);
        next.delete(participantId);
        this.replying = next;
        if (this.live?.participantId === participantId) this.live = null;
      } else {
        this.replying = new Set();
        this.live = null;
      }
    }
  }

  async send(text: string, opts: { type?: "text" | "file" } = {}): Promise<void> {
    if (!this.currentChatId || !text.trim()) return;
    // whispers are typed as @username in the text; the backend resolves them
    await api.sendMessage(this.currentChatId, text, { type: opts.type });
    // message arrives via SSE; poll as a safety net for transient stream drops
    await this.pollLatest();
  }

  private lastPollAt = 0;
  async pollLatest(): Promise<void> {
    if (!this.currentChatId) return;
    const chatId = this.currentChatId;
    const generation = this.chatLoadGeneration;
    const last = this.messages[this.messages.length - 1];
    const res = await api.pollMessages(chatId, last?.id ?? seedId(chatId)).catch(() => null);
    if (!res) return;
    if (generation !== this.chatLoadGeneration || chatId !== this.currentChatId) return;
    const known = new Set(this.messages.map((m) => m.id));
    const fresh = res.messages.filter((m) => !known.has(m.id));
    if (fresh.length > 0) this.messages = [...this.messages, ...fresh];
  }

  async createChat(
    participants: {
      role: "user" | "ai";
      name?: string;
      model?: string;
      apiRouter?: string;
      maxContext?: number;
      apiKeyName?: string;
      prompt?: string;
      cardId?: string;
    }[],
    name?: string,
  ): Promise<void> {
    const { chatId } = await api.createChat({ participants, name });
    await this.refreshChats();
    await this.openChat(chatId);
  }

  async uploadFile(chatId: string, filename: string, file: Blob, signal?: AbortSignal): Promise<{ messageId: string }> {
    return await api.uploadFile(chatId, filename, file, signal);
  }

  async renameCurrentChatById(chatId: string, name: string): Promise<void> {
    const previous = this.chats.find((chat) => chat.id === chatId)?.name;
    // Keep the sidebar responsive even when the chats polling endpoint is
    // slow or unavailable. The PATCH remains authoritative; restore the
    // previous value if it fails.
    this.chats = this.chats.map((chat) => (chat.id === chatId ? { ...chat, name } : chat));
    try {
      await api.renameChat(chatId, name);
    } catch (error) {
      this.chats = this.chats.map((chat) => (chat.id === chatId ? { ...chat, name: previous } : chat));
      throw error;
    }
  }

  async renameCurrentChat(name: string): Promise<void> {
    if (!this.currentChatId) return;
    await this.renameCurrentChatById(this.currentChatId, name);
  }

  async deleteChat(chatId: string): Promise<void> {
    await api.deleteChat(chatId);
    if (this.currentChatId === chatId) {
      this.chatLoadGeneration += 1;
      this.currentChatId = null;
      this.messages = [];
      this.closeStream?.();
      this.closeStream = null;
    }
    await this.refreshChats();
    if (!this.currentChatId && this.chats.length > 0) {
      await this.openChat(this.chats[this.chats.length - 1].id);
    }
  }

  async start(): Promise<void> {
    await this.refreshAiCards();
  }

  async updateSettings(patch: Partial<ChatSettings>): Promise<void> {
    if (!this.currentChatId) return;
    this.settings = await api.updateChatSettings(this.currentChatId, patch);
  }

  async login(name: string, credential: string): Promise<void> {
    // admin CLI registers users as <name>@iris.local
    const res = await authClient.signIn.email({
      email: `${name}@iris.local`,
      password: credential,
    });
    if (res.error) throw new Error(res.error.message ?? "login failed");
    this.session = { kind: "user", name };
    const session = await authClient.getSession();
    this.isAdmin = (session.data?.user as { role?: string } | undefined)?.role === "admin";
    this.participants = [];
    await this.refreshChats();
    await this.refreshAiCards();
  }

  async changeCredential(currentCredential: string, newCredential: string): Promise<void> {
    const res = await authClient.changePassword({
      currentPassword: currentCredential,
      newPassword: newCredential,
      revokeOtherSessions: true,
    });
    if (res.error) throw new Error(res.error.message ?? "credential change failed");
  }

  /** Probe the backend with a cheap request; updates backendOnline. */
  async checkBackend(): Promise<boolean> {
    const online = await this.backendLifecycle.probe(apiUrl("/api/models"));
    this.backendOnline = online;
    this.backendStatus = this.backendLifecycle.status;
    if (!online) pushToast("warn", "server unreachable");
    return online;
  }

  async setMyImage(dataUri: string): Promise<void> {
    const res = await authClient.updateUser({ image: dataUri });
    if (res.error) throw new Error(res.error.message ?? "upload failed");
    this.myImage = dataUri;
  }

  async logout(): Promise<void> {
    // Invalidate all callbacks before awaiting the network sign-out. This
    // prevents an in-flight openChat/refresh from repopulating guest state.
    this.chatLoadGeneration += 1;
    this.chatsRefreshGeneration += 1;
    this.aiCardsRefreshGeneration += 1;
    this.closeStream?.();
    this.closeStream = null;
    for (const player of this.audioPlayers) {
      player.pause();
      player.removeAttribute("src");
      player.load();
    }
    this.audioPlayers.clear();
    await authClient.signOut();
    this.session = { kind: "guest" };
    this.isAdmin = false;
    this.chats = [];
    this.currentChatId = null;
    this.messages = [];
    this.participants = [];
    this.replying = new Set();
    this.live = null;
    this.liveMentions = new Set();
    this.settings = { userInterruptions: true, aiInterruptions: false };
    this.guestChatId = null;
    this.guestChatFailed = false;
    this.hasMoreHistory = false;
    this.loadingOlder = false;
    this.aiCards = [];
    this.compaction = {};
    this.myId = null;
    this.myImage = null;
    this.pendingToolRequests = [];
  }
}

/**
 * Seed id for "everything": the backend requires a lastMessageId that must
 * exist, so we use the chatId itself (never a message id) and treat a
 * not-found as empty history.
 */
function seedId(chatId: string): string {
  return chatId;
}

export const app = new AppState();

function isUiPrefs(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a persisted UI layout pref (iris.ui localStorage JSON). */
function uiPref(key: string, fallback: boolean): boolean {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem("iris.ui") ?? "{}");
    if (!isUiPrefs(raw)) return fallback;
    return typeof raw[key] === "boolean" ? raw[key] : fallback;
  } catch {
    return fallback;
  }
}

// persist panel layout across restarts
$effect.root(() => {
  $effect(() => {
    const prefs = { leftOpen: app.leftOpen, rightOpen: app.rightOpen, bottomOpen: app.bottomOpen };
    localStorage.setItem("iris.ui", JSON.stringify(prefs));
  });
});
