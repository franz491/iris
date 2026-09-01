// lib/api.ts — backend API client.
import { apiUrl, authClient } from "./backend";

/** fetch that always sends credentials (cookies) so the backend may live on
 *  a different origin; harmless for same-origin requests. */
const fapi = (path: string, init?: RequestInit): Promise<Response> => fetch(path, { credentials: "include", ...init });
import { pushToast } from "./toasts.svelte";
import type { Message } from "./types";
import { isNonEmptyString, isNonNegativeInteger, isRecord, isString, type JsonRecord } from "./schema";

export { authClient };

export type ChatEvent =
  | { kind: "message"; message: Message }
  | { kind: "edit"; message: Message }
  | { kind: "branch_rewritten"; message: Message; deletedFollowing?: number }
  | { kind: "willReply"; participantId: string }
  | { kind: "stream"; participantId: string; chunk: { delta?: string; thoughtDelta?: string } }
  | { kind: "routing"; participantId: string; recipientParticipantIds: string[]; routingVersion: 1 }
  | { kind: "done"; participantId: string; interrupted?: boolean }
  | { kind: "deleted" }
  | {
      kind: "tool_request";
      requestId: string;
      tool: string;
      arguments: unknown;
      requiresApproval: boolean;
      targetUserId?: string;
      targetClientId?: string;
    }
  | { kind: "audio_ready"; token: string; participantId?: string }
  | { kind: "truncated"; fromMessageId: string }
  | { kind: "compacting"; name?: string; participantId?: string }
  | { kind: "compacted"; name?: string; participantId?: string };

const optionalString = (data: JsonRecord, key: string): string | undefined =>
  data[key] === undefined ? undefined : isString(data[key]) ? data[key] : "__invalid__";

function isMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.chatId) &&
    isNonEmptyString(value.authorId) &&
    (value.type === "tool" ||
      value.type === "text" ||
      value.type === "file" ||
      value.type === "tool_result" ||
      value.type === "compaction") &&
    isString(value.thought) &&
    isString(value.content) &&
    isString(value.createdAt) &&
    (value.seq === undefined || (typeof value.seq === "number" && Number.isInteger(value.seq))) &&
    (value.to === undefined || (Array.isArray(value.to) && value.to.every(isString)))
  );
}

function isPollMessagesResponse(value: unknown): value is { messages: Message[] } {
  return isRecord(value) && Array.isArray(value.messages) && value.messages.every(isMessage);
}

function isChatSummary(value: unknown): value is import("./types").ChatSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isString(value.createdAt) &&
    (value.name === undefined || isString(value.name))
  );
}

function isPollChatsResponse(value: unknown): value is { chats: import("./types").ChatSummary[] } {
  return isRecord(value) && Array.isArray(value.chats) && value.chats.every(isChatSummary);
}

function isSetupInfoResponse(
  value: unknown,
): value is { defaultModel: { apiRouter: string; model: string; maxContext: number } } {
  if (!isRecord(value) || !isRecord(value.defaultModel)) return false;
  const model = value.defaultModel;
  return (
    isNonEmptyString(model.apiRouter) &&
    isNonEmptyString(model.model) &&
    typeof model.maxContext === "number" &&
    Number.isSafeInteger(model.maxContext) &&
    model.maxContext > 0
  );
}

function isModelRoutersResponse(value: unknown): value is { routers: string[] } {
  return isRecord(value) && Array.isArray(value.routers) && value.routers.every(isNonEmptyString);
}

function isModelsResponse(value: unknown): value is { models: { id: string; contextWindow?: number }[] } {
  return (
    isRecord(value) &&
    Array.isArray(value.models) &&
    value.models.every(
      (model) =>
        isRecord(model) &&
        isNonEmptyString(model.id) &&
        (model.contextWindow === undefined ||
          (typeof model.contextWindow === "number" &&
            Number.isSafeInteger(model.contextWindow) &&
            model.contextWindow > 0)),
    )
  );
}

function isAiCard(value: unknown): value is import("./types").AiCard {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.model) &&
    isNonEmptyString(value.apiRouter) &&
    typeof value.maxContext === "number" &&
    Number.isSafeInteger(value.maxContext) &&
    value.maxContext > 0 &&
    isString(value.prompt) &&
    isNonEmptyString(value.createdAt) &&
    (value.avatarSeed === undefined || isString(value.avatarSeed)) &&
    (value.avatar === undefined || isString(value.avatar))
  );
}

function isAiCardsResponse(value: unknown): value is { cards: import("./types").AiCard[] } {
  return isRecord(value) && Array.isArray(value.cards) && value.cards.every(isAiCard);
}

function isHistoryPageResponse(
  value: unknown,
): value is { messages: import("./types").Message[]; hasMore: boolean; oldestSeq: number | null } {
  return (
    isRecord(value) &&
    Array.isArray(value.messages) &&
    value.messages.every(isMessage) &&
    typeof value.hasMore === "boolean" &&
    (value.oldestSeq === null || isNonNegativeInteger(value.oldestSeq))
  );
}

function isGuestChatResponse(value: unknown): value is { chatId: string; name?: string } {
  return isRecord(value) && isNonEmptyString(value.chatId) && (value.name === undefined || isString(value.name));
}

function isChatMutationResponse(value: unknown): value is { chatId: string } {
  return isRecord(value) && isNonEmptyString(value.chatId);
}

function isChatSettingsResponse(value: unknown): value is import("./types").ChatSettings {
  return (
    isRecord(value) &&
    typeof value.userInterruptions === "boolean" &&
    typeof value.aiInterruptions === "boolean" &&
    (value.forceAiReply === undefined || typeof value.forceAiReply === "boolean")
  );
}

/** Validate an untrusted SSE payload and narrow it to a state-safe event. */
export function parseChatEvent(value: unknown): ChatEvent | null {
  if (!isRecord(value) || !isString(value.kind)) return null;
  const kind = value.kind;
  if (kind === "message" || kind === "edit") return isMessage(value.message) ? { kind, message: value.message } : null;
  if (kind === "branch_rewritten") {
    return isMessage(value.message) &&
      (value.deletedFollowing === undefined || isNonNegativeInteger(value.deletedFollowing))
      ? {
          kind,
          message: value.message,
          ...(value.deletedFollowing === undefined ? {} : { deletedFollowing: value.deletedFollowing }),
        }
      : null;
  }
  if (kind === "willReply" || kind === "done") {
    return isNonEmptyString(value.participantId) &&
      (kind !== "done" || value.interrupted === undefined || typeof value.interrupted === "boolean")
      ? ({
          kind,
          participantId: value.participantId,
          ...(kind === "done" && value.interrupted !== undefined ? { interrupted: value.interrupted } : {}),
        } as ChatEvent)
      : null;
  }
  if (kind === "stream") {
    const chunk = value.chunk;
    return isNonEmptyString(value.participantId) &&
      isRecord(chunk) &&
      (chunk.delta === undefined || isString(chunk.delta)) &&
      (chunk.thoughtDelta === undefined || isString(chunk.thoughtDelta)) &&
      (chunk.delta !== undefined || chunk.thoughtDelta !== undefined)
      ? {
          kind,
          participantId: value.participantId,
          chunk: {
            ...(chunk.delta === undefined ? {} : { delta: chunk.delta }),
            ...(chunk.thoughtDelta === undefined ? {} : { thoughtDelta: chunk.thoughtDelta }),
          },
        }
      : null;
  }
  if (kind === "routing") {
    return isNonEmptyString(value.participantId) &&
      value.routingVersion === 1 &&
      Array.isArray(value.recipientParticipantIds) &&
      value.recipientParticipantIds.length > 0 &&
      value.recipientParticipantIds.every(isNonEmptyString)
      ? {
          kind,
          participantId: value.participantId,
          routingVersion: 1,
          recipientParticipantIds: [...new Set(value.recipientParticipantIds)],
        }
      : null;
  }
  if (kind === "deleted" || kind === "truncated")
    return kind === "deleted" || isString(value.fromMessageId)
      ? ({ kind, ...(kind === "truncated" ? { fromMessageId: value.fromMessageId } : {}) } as ChatEvent)
      : null;
  if (kind === "audio_ready")
    return isNonEmptyString(value.token) && (value.participantId === undefined || isNonEmptyString(value.participantId))
      ? {
          kind,
          token: value.token,
          ...(value.participantId === undefined ? {} : { participantId: value.participantId }),
        }
      : null;
  if (kind === "tool_request")
    return isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.tool) &&
      typeof value.requiresApproval === "boolean" &&
      (value.targetUserId === undefined || isNonEmptyString(value.targetUserId)) &&
      (value.targetClientId === undefined || isNonEmptyString(value.targetClientId))
      ? {
          kind,
          requestId: value.requestId,
          tool: value.tool,
          arguments: value.arguments,
          requiresApproval: value.requiresApproval,
          ...(value.targetUserId === undefined ? {} : { targetUserId: value.targetUserId }),
          ...(value.targetClientId === undefined ? {} : { targetClientId: value.targetClientId }),
        }
      : null;
  if (kind === "compacting" || kind === "compacted") {
    const name = optionalString(value, "name");
    const participantId = optionalString(value, "participantId");
    return name !== "__invalid__" && participantId !== "__invalid__"
      ? { kind, ...(name === undefined ? {} : { name }), ...(participantId === undefined ? {} : { participantId }) }
      : null;
  }
  return null;
}

function isParticipant(value: unknown): value is import("./types").Participant {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    isNonEmptyString(p.id) &&
    isNonEmptyString(p.chatId) &&
    (p.role === "user" || p.role === "ai") &&
    isNonEmptyString(p.name) &&
    isNonEmptyString(p.createdAt)
  );
}
function isParticipantsResponse(value: unknown): value is { participants: import("./types").Participant[] } {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as { participants?: unknown }).participants) &&
    (value as { participants: unknown[] }).participants.every(isParticipant)
  );
}
function isEditMessageResponse(
  value: unknown,
): value is { message: import("./types").Message; deletedFollowing: number; regenerating: boolean } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    isMessage(v.message) &&
    Number.isInteger(v.deletedFollowing) &&
    (v.deletedFollowing as number) >= 0 &&
    typeof v.regenerating === "boolean"
  );
}

function isMessageIdResponse(value: unknown): value is { messageId: string } {
  return !!value && typeof value === "object" && isNonEmptyString((value as { messageId?: unknown }).messageId);
}
function isAudioHandleResponse(value: unknown): value is { audioHandle: string } {
  return !!value && typeof value === "object" && isNonEmptyString((value as { audioHandle?: unknown }).audioHandle);
}
function isCompactionResponse(value: unknown): value is { progress: Record<string, number> } {
  if (!value || typeof value !== "object") return false;
  const progress = (value as { progress?: unknown }).progress;
  if (!progress || typeof progress !== "object") return false;
  return Object.values(progress as Record<string, unknown>).every((n) => typeof n === "number" && Number.isFinite(n));
}

async function handle<T>(res: Response, validate?: (value: unknown) => value is T): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; message?: string };
      msg = j.message ?? j.error ?? msg;
    } catch {
      /* ignore */
    }
    pushToast("error", msg);
    throw new Error(msg);
  }
  const value: unknown = await res.json();
  if (validate && !validate(value)) throw new Error("Invalid API response");
  return value as T;
}

export const api = {
  async createChat(body: {
    participants: {
      role: "user" | "ai";
      name?: string;
      userId?: string;
      model?: string;
      apiRouter?: string;
      maxContext?: number;
      apiKeyName?: string;
      prompt?: string;
      cardId?: string;
    }[];
    settings?: { userInterruptions: boolean; aiInterruptions: boolean };
    name?: string;
  }): Promise<{ chatId: string }> {
    return handle(
      await fapi(`${apiUrl("/api")}/chats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      isChatMutationResponse,
    );
  },

  async sendMessage(
    chatId: string,
    content: string,
    opts: { to?: string[]; type?: "text" | "file" } = {},
  ): Promise<{ messageId: string }> {
    return handle(
      await fapi(`${apiUrl("/api")}/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, to: opts.to, type: opts.type }),
      }),
    );
  },

  async updateAiParticipant(
    chatId: string,
    participantId: string,
    patch: { readsOthersThoughts: boolean },
  ): Promise<{ ok: boolean }> {
    return handle(
      await fapi(`${apiUrl("/api")}/chats/${chatId}/participants/${participantId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },

  async stopAi(chatId: string, participantId?: string): Promise<{ stopped: string[] }> {
    return handle(
      await fapi(`${apiUrl("/api")}/chats/${chatId}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(participantId ? { participantId } : {}),
      }),
    );
  },

  async pollMessages(chatId: string, lastMessageId: string): Promise<{ messages: import("./types").Message[] }> {
    const qs = new URLSearchParams({ chatId, lastMessageId });
    return handle(await fapi(`${apiUrl("/api")}/polling/messages?${qs}`), isPollMessagesResponse);
  },

  async pollChats(timestamp: number): Promise<{ chats: import("./types").ChatSummary[] }> {
    return handle(await fapi(`${apiUrl("/api")}/polling/chats?timestamp=${timestamp}`), isPollChatsResponse);
  },

  async getGuestChat(): Promise<{ chatId: string; name?: string }> {
    return handle(await fapi(`${apiUrl("/api")}/chats/guest`), isGuestChatResponse);
  },

  async renameChat(chatId: string, name: string): Promise<void> {
    await handle(
      await fapi(`${apiUrl("/api")}/chats/${chatId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
  },

  async deleteChat(chatId: string): Promise<void> {
    await handle(await fapi(`${apiUrl("/api")}/chats/${chatId}`, { method: "DELETE" }));
  },

  async clearContext(chatId: string): Promise<void> {
    await handle(await fapi(`${apiUrl("/api")}/chats/${chatId}/context`, { method: "DELETE" }));
  },

  async listAiCards(): Promise<{ cards: import("./types").AiCard[] }> {
    return handle(await fapi(`${apiUrl("/api")}/ai-cards`), isAiCardsResponse);
  },

  async createAiCard(card: {
    name: string;
    model?: string;
    apiRouter?: string;
    maxContext?: number;
    prompt?: string;
  }): Promise<import("./types").AiCard> {
    return handle(
      await fapi(`${apiUrl("/api")}/ai-cards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(card),
      }),
    );
  },

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
  ): Promise<import("./types").AiCard> {
    return handle(
      await fapi(`${apiUrl("/api")}/ai-cards/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },

  async deleteAiCard(id: string): Promise<void> {
    await handle(await fapi(`${apiUrl("/api")}/ai-cards/${id}`, { method: "DELETE" }));
  },

  async pushToolConfig(chatId: string, clientId: string, config: import("./tools").ToolConfig): Promise<void> {
    await handle(
      await fapi(`${apiUrl("/api")}/chats/${chatId}/tool-config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...config, clientId }),
      }),
    );
  },

  async respondToolRequest(
    chatId: string,
    body: { requestId: string; clientId: string; approved: boolean; result?: unknown; error?: string },
  ): Promise<void> {
    await handle(
      await fapi(`${apiUrl("/api")}/chats/${chatId}/tool-response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },

  async listModels(router = "llamacpp"): Promise<{ models: { id: string; contextWindow?: number }[] }> {
    return handle(await fapi(`${apiUrl("/api")}/models?router=${encodeURIComponent(router)}`), isModelsResponse);
  },

  async listModelRouters(): Promise<{ routers: string[] }> {
    return handle(await fapi(`${apiUrl("/api")}/model-routers`), isModelRoutersResponse);
  },

  async getSetupInfo(): Promise<{ defaultModel: { apiRouter: string; model: string; maxContext: number } }> {
    return handle(await fapi(`${apiUrl("/api")}/setup-info`), isSetupInfoResponse);
  },

  async addParticipant(
    chatId: string,
    body: {
      role: "user" | "ai";
      name: string;
      model?: string;
      apiRouter?: string;
      maxContext?: number;
      prompt?: string;
    },
  ): Promise<import("./types").Participant> {
    return handle(
      await fapi(`${apiUrl("/api")}/chats/${chatId}/participants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      isParticipant,
    );
  },

  async editMessage(
    chatId: string,
    messageId: string,
    patch: { content?: string; thought?: string },
  ): Promise<{ message: import("./types").Message; deletedFollowing: number; regenerating: boolean }> {
    return handle(
      await fapi(`${apiUrl("/api")}/chats/${chatId}/messages/${messageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
      isEditMessageResponse,
    );
  },

  async getHistoryPage(
    chatId: string,
    before: number | null,
    limit = 50,
  ): Promise<{ messages: import("./types").Message[]; hasMore: boolean; oldestSeq: number | null }> {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before !== null) qs.set("before", String(before));
    return handle(await fapi(`${apiUrl("/api")}/chats/${chatId}/history?${qs}`), isHistoryPageResponse);
  },

  async getCompaction(chatId: string): Promise<{ progress: Record<string, number> }> {
    return handle(await fapi(`${apiUrl("/api")}/chats/${chatId}/compaction`), isCompactionResponse);
  },

  async compactAi(chatId: string, participantId: string): Promise<void> {
    await handle(await fapi(`${apiUrl("/api")}/chats/${chatId}/compact/${participantId}`, { method: "POST" }));
  },

  async getParticipants(chatId: string): Promise<{ participants: import("./types").Participant[] }> {
    return handle(await fapi(`${apiUrl("/api")}/chats/${chatId}/participants`), isParticipantsResponse);
  },

  async getChatSettings(chatId: string): Promise<import("./types").ChatSettings> {
    // no dedicated GET yet; PATCH returns the merged settings
    return handle(
      await fapi(`${apiUrl("/api")}/chats/${chatId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      isChatSettingsResponse,
    );
  },

  async updateChatSettings(
    chatId: string,
    patch: Partial<import("./types").ChatSettings>,
  ): Promise<import("./types").ChatSettings> {
    return handle(
      await fapi(`${apiUrl("/api")}/chats/${chatId}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
      isChatSettingsResponse,
    );
  },

  async uploadFile(chatId: string, filename: string, file: Blob, signal?: AbortSignal): Promise<{ messageId: string }> {
    // stored in the sandbox under chats/<chatId>/<filename>
    const path = `chats/${chatId}/${encodeURIComponent(filename)}`;
    return handle(
      await fapi(`${apiUrl("/api")}/files/${path}`, { method: "PUT", body: file, signal }),
      isMessageIdResponse,
    );
  },

  fileUrl(chatId: string, filename: string): string {
    return `${apiUrl("/api")}/files/chats/${chatId}/${encodeURIComponent(filename)}`;
  },

  async downloadFile(chatId: string, filename: string): Promise<Blob> {
    const res = await fapi(`${apiUrl("/api")}/files/chats/${chatId}/${encodeURIComponent(filename)}`);
    if (!res.ok) {
      let message = `download failed: ${res.status}`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        /* binary/non-JSON response */
      }
      throw new Error(message);
    }
    return await res.blob();
  },

  transientAudioUrl(token: string): string {
    return `${apiUrl("/api")}/audio/${encodeURIComponent(token)}`;
  },

  async createAudioHandle(chatId: string, audio: Blob): Promise<{ audioHandle: string }> {
    return handle(
      await fapi(`${apiUrl("/api")}/audio-handles?chatId=${encodeURIComponent(chatId)}`, {
        method: "POST",
        headers: { "content-type": audio.type || "audio/wav" },
        body: audio,
      }),
      isAudioHandleResponse,
    );
  },

  playbackAudioUrl(id: string, chatId: string): string {
    return `${apiUrl("/api")}/audio-cache/${encodeURIComponent(id)}?chatId=${encodeURIComponent(chatId)}`;
  },

  async callProvider<T>(name: string, functionality: string, kwargs: unknown): Promise<T> {
    return handle(
      await fapi(`${apiUrl("/api")}/providers/${name}/${functionality}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(kwargs),
      }),
    );
  },
};

/** Live SSE subscription with auto-reconnect. Returns a closer. */
export function subscribeToChat(
  chatId: string,
  clientId: string,
  onEvent: (event: ChatEvent) => void,
  opts: { onReconnect?: () => void; onDisconnect?: () => void } = {},
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const kinds = [
    "message",
    "edit",
    "branch_rewritten",
    "willReply",
    "stream",
    "done",
    "deleted",
    "tool_request",
    "audio_ready",
    "truncated",
    "compacting",
    "compacted",
  ];

  function connect() {
    if (closed) return;
    es = new EventSource(`${apiUrl("/api")}/chats/${chatId}/stream?clientId=${encodeURIComponent(clientId)}`, {
      withCredentials: true,
    });
    es.onopen = () => {
      if (attempt > 0 && opts.onReconnect) opts.onReconnect();
      attempt = 0;
    };
    es.onerror = () => {
      // EventSource retries by itself for HTTP 200 streams that end, but not
      // for server-down; close and retry with capped backoff.
      es?.close();
      es = null;
      if (closed) return;
      if (opts.onDisconnect) opts.onDisconnect();
      attempt += 1;
      const delay = Math.min(15000, 500 * 2 ** Math.min(attempt, 5)) + Math.random() * 300;
      timer = setTimeout(connect, delay);
    };
    for (const k of kinds) {
      const h = (e: MessageEvent) => {
        let data: unknown;
        try {
          data = JSON.parse(e.data);
        } catch {
          /* malformed packet */
          return;
        }
        if (!isRecord(data)) return;
        const event = parseChatEvent({ kind: k, ...data });
        if (event) onEvent(event);
      };
      es.addEventListener(k, h as EventListener);
    }
  }

  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    es?.close();
  };
}
