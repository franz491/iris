// api/api.ts — the main API surface (Hono app).
import { Hono } from "hono";
import { PushQueue } from "./stream-response.js";
import { registerSse } from "./sse-owner.js";
import { createChat, getChat, clearContext, evictChat } from "../chat/chat.js";
import { getParticipantsRows } from "../chat/database.js";
import { findUserByName, getUserImage, getUserName } from "./auth.js";
import { getAppMeta, renameChat, deleteChat, ensureGuestChatAtomic } from "../chat/database.js";
import { isUserAuthorizedInChat } from "../chat/auth.js";
import { getMessagesSinceId as pollMessages, getChatsSinceTimestamp } from "../chat/polling.js";
import { ValidationError, toAppError } from "../misc/error.js";
import { canReadMessage } from "../chat/ai-participants.js";
import { getTransientAudio, registerTransientAudio } from "./transient-audio.js";
import { getPlaybackMetadata, readCachedAudio } from "../admin/audio-cache.js";
import { getAdminConfig } from "../admin/store.js";
import { readBoundedBody, validateWavUpload } from "./binary-limits.js";
import { modelAdmission, modelRateLimitResponse } from "./model-admission.js";
import { uploadSource } from "./upload-limiter.js";
import { registerApiMiddleware } from "./api-middleware.js";
export { accessLogRecord, resolveRequestCorrelationId } from "./api-middleware.js";
import { readRuntimeConfig } from "../config/runtime.js";
import { readRuntimeLimits } from "../config/runtime-limits.js";
import { guestChatLimiter, guestChatRateLimitResponse } from "./guest-chat-limiter.js";
import { parseGeneratedAudioResult } from "../chat/generation-audio-handler.js";
import { parsePollingChatsQuery, parsePollingMessagesQuery, registerPollingRoutes } from "./polling-routes.js";
import { registerAudioHandleRoutes, parseAudioHandleQuery } from "./audio-handle-routes.js";
import { parseModelsQuery, registerModelRoutes } from "./model-routes.js";
import { registerToolRoutes, parseToolsQuery } from "./tool-routes.js";
import { registerStreamRoutes, parseStreamQuery } from "./stream-routes.js";
import { registerCompactionRoutes } from "./compaction-routes.js";
import { registerToolControlRoutes, toolConfigSchema, toolResponseSchema } from "./tool-control-routes.js";
import { registerAudioCacheRoutes, parseAudioCacheQuery } from "./audio-cache-routes.js";
import { registerChatReadRoutes, parseHistoryQuery } from "./chat-read-routes.js";
import { registerAiCardRoutes } from "./ai-card-routes.js";
import { registerMessageMutationRoutes, rewriteMessageSchema } from "./message-mutation-routes.js";
import {
  registerParticipantRoutes,
  addParticipantSchema,
  participantPatchSchema,
  chatSettingsPatchSchema,
} from "./participant-routes.js";
import { registerChatLifecycleRoutes, renameChatSchema } from "./chat-lifecycle-routes.js";
import { registerStopRoutes, stopChatSchema } from "./stop-routes.js";
import { scheduleGuestHygiene } from "./guest-hygiene.js";
import { registerGuestChatRoutes } from "./guest-chat-routes.js";
import { registerChatCreationRoutes } from "./chat-creation-service.js";
import { registerMessageRoutes, createMessageSchema } from "./message-routes.js";
import { createAudioCachePlaybackService } from "./audio-cache-service.js";
import { readSetupSettings } from "../setup/settings.js";
import { listRouters, modelContextWindow } from "../model-router/model-manager.js";
import { createFilterReadable, createReadableChatEvent } from "./readability.js";
import { resolveViewer, requireAuthenticatedUser, requireChatMember } from "./auth-guards.js";
import { parseRouteId } from "./api-validation.js";
export { parseRouteId, parseStrictSingleQuery } from "./api-validation.js";
export {
  resolveViewer,
  requireAuthenticatedUser,
  requireChatMember,
  requireAdmin,
  requireRecentAuth,
} from "./auth-guards.js";

export const api = new Hono();
registerApiMiddleware(api);

export function parseAudioReplayResult(value: unknown): { base64: string; mimeType?: string } | null {
  return parseGeneratedAudioResult(value);
}

const regeneratePlayback = createAudioCachePlaybackService();

const readabilityDeps = { getParticipantsRows, canReadMessage };
const filterReadable = createFilterReadable(readabilityDeps);
const readableChatEvent = createReadableChatEvent(readabilityDeps);

/** @deprecated Use resolveViewer(), requireChatMember(), or requireAdmin(). */
export const requireUser = resolveViewer;
/** @deprecated Use requireAuthenticatedUser(). */
export const requireRegistered = requireAuthenticatedUser;

// Ephemeral generated audio: held only in memory for long enough for every
// connected client in the chat to fetch and play it.
registerAudioHandleRoutes(api, {
  requireUser,
  parseToken: (value) => parseRouteId(value, "audio token"),
  parseChatQuery: parseAudioHandleQuery,
  getTransientAudio,
  isUserAuthorizedInChat,
  readBoundedBody,
  maxAudioBytes: () => readRuntimeLimits().audioHandleBytes,
  validateWavUpload,
  registerTransientAudio,
  errorResponse: errResponse,
});

registerAudioCacheRoutes(api, {
  requireUser,
  parseChatQuery: parseAudioCacheQuery,
  parseCacheId: (value) => parseRouteId(value, "audio cache id"),
  isUserAuthorizedInChat,
  readCacheConfig: () => getAdminConfig().config.cache,
  readCachedAudio,
  getPlaybackMetadata,
  regeneratePlayback,
  errorResponse: errResponse,
});

// ---------- chats ----------
registerChatCreationRoutes(api, {
  requireAuthenticatedUser,
  getUserName,
  findUserByName,
  readSetupSettings,
  listRouters,
  modelContextWindow,
  createChat,
  errorResponse: errResponse,
});

registerMessageRoutes(api, {
  requireUser,
  getSource: uploadSource,
  consumeGuest: (key, limit) => guestChatLimiter.consume(key, limit),
  guestMessageLimit: readRuntimeLimits().guestMessagesPerWindow,
  rateLimitResponse: guestChatRateLimitResponse,
  parseChatId: (value) => parseRouteId(value, "chat id"),
  isUserAuthorizedInChat,
  parseBody: async (request) => {
    const bodyResult = createMessageSchema.safeParse(await request.json().catch(() => undefined));
    if (!bodyResult.success) throw new ValidationError("invalid message payload", bodyResult.error.flatten());
    return bodyResult.data;
  },
  getChat,
  scheduleGuestHygiene: (chatId) =>
    scheduleGuestHygiene(chatId, {
      getAppMeta,
      readKeep: () => readRuntimeConfig().guestChatKeep,
      pruneMessages: async (...args) => {
        await (await import("../chat/database.js")).pruneOldMessages(...args);
      },
    }),
  tryAcquire: (keys, slots) => modelAdmission.tryAcquire(keys, slots),
  modelRateLimitResponse,
  errorResponse: errResponse,
});

registerStopRoutes(api, {
  requireUser,
  parseChatId: (value) => parseRouteId(value, "chat id"),
  isUserAuthorizedInChat,
  getChat,
  parseStopBody: async (request) => {
    const bodyResult = stopChatSchema.safeParse(await request.json().catch(() => undefined));
    if (!bodyResult.success) throw new ValidationError("invalid stop payload", bodyResult.error.flatten());
    return bodyResult.data;
  },
  errorResponse: errResponse,
});

registerStreamRoutes(api, {
  requireUser,
  parseChatId: (value) => parseRouteId(value, "chat id"),
  parseStreamQuery,
  isUserAuthorizedInChat,
  getChat,
  readableChatEvent,
  createQueue: <T>() => new PushQueue<T>(),
  registerSse,
  errorResponse: errResponse,
});

registerMessageMutationRoutes(api, {
  requireUser,
  parseChatId: (value) => parseRouteId(value, "chat id"),
  parseMessageId: (value) => parseRouteId(value, "message id"),
  isUserAuthorizedInChat,
  parseRewriteBody: async (request) => {
    const bodyResult = rewriteMessageSchema.safeParse(await request.json().catch(() => undefined));
    if (!bodyResult.success) throw new ValidationError("invalid rewrite payload", bodyResult.error.flatten());
    return bodyResult.data;
  },
  getChat,
  deleteMessageAndFollowing: async (...args) =>
    (await import("../chat/database.js")).deleteMessageAndFollowing(...args),
  errorResponse: errResponse,
});

/** Paged history: up to `limit` messages older than `before` (seq cursor). */
registerChatReadRoutes(api, {
  requireUser,
  parseChatId: (value) => parseRouteId(value, "chat id"),
  parseHistoryQuery,
  isUserAuthorizedInChat,
  getHistoryPage: async (...args) => (await import("../chat/database.js")).getHistoryPage(...args),
  filterReadable,
  getChat,
  errorResponse: errResponse,
});

registerPollingRoutes(api, {
  requireUser,
  parseMessagesQuery: parsePollingMessagesQuery,
  parseChatsQuery: parsePollingChatsQuery,
  isUserAuthorizedInChat,
  getMessagesSinceId: pollMessages,
  getChatsSinceTimestamp,
  filterReadable,
  errorResponse: errResponse,
});

/**
 * Universal guest chat: find-or-create the single chat every guest shares.
 * It has no registered users, so guest access rules apply naturally.
 */
// ---------- AI cards ----------
registerAiCardRoutes(api, {
  requireRegistered,
  parseRouteId,
  listAiCards: async (userId) => (await import("../chat/database.js")).listAiCards(userId),
  createAiCard: async (userId, input) => (await import("../chat/database.js")).createAiCard(userId, input),
  updateAiCard: async (userId, id, patch) => (await import("../chat/database.js")).updateAiCard(userId, id, patch),
  deleteAiCard: async (userId, id) => (await import("../chat/database.js")).deleteAiCard(userId, id),
  propagateCard: async (id, patch) => (await import("../chat/database.js")).propagateCard(id, patch),
  listRouters: async () => (await import("../model-router/model-manager.js")).listRouters(),
  modelContextWindow: async (router, model) =>
    (await import("../model-router/model-manager.js")).modelContextWindow(router, model),
  errorResponse: errResponse,
});

// ---------- AI tools ----------
registerToolRoutes(api, {
  resolveViewer,
  parseToolsQuery,
  isUserAuthorizedInChat,
  getChat,
  loadCatalog: async () => {
    const { TOOL_GROUPS, loadToolDocs, ALWAYS_LOADED_GROUPS, aiGroupName } = await import("../chat/tools.js");
    return { groups: TOOL_GROUPS, alwaysLoadedGroups: ALWAYS_LOADED_GROUPS, loadToolDocs, aiGroupName };
  },
  errorResponse: errResponse,
});

/** Push tool configuration and answer a pending frontend-tool request. */
registerToolControlRoutes(api, {
  parseChatId: (value) => parseRouteId(value, "chat id"),
  requireChatMember,
  parseToolConfig: (body) => {
    const result = toolConfigSchema.safeParse(body);
    if (!result.success) throw new ValidationError("invalid tool configuration", result.error.flatten());
    return result.data;
  },
  parseToolResponse: (body) => {
    const result = toolResponseSchema.safeParse(body);
    if (!result.success) throw new ValidationError("invalid tool response", result.error.flatten());
    return result.data;
  },
  getChat,
  errorResponse: errResponse,
});

// ---------- compaction ----------
registerCompactionRoutes(api, {
  requireUser,
  parseChatId: (value) => parseRouteId(value, "chat id"),
  parseParticipantId: (value) => parseRouteId(value, "participant id"),
  isUserAuthorizedInChat,
  getChat,
  compactionProgress: async (chatId, participants) =>
    (await import("../chat/ai-participants.js")).compactionProgress(chatId, participants as never),
  compactChat: async (participant) => (await import("../chat/ai-participants.js")).compactChat(participant as never),
  errorResponse: errResponse,
});

registerModelRoutes(api, {
  requireUser,
  parseModelsQuery,
  listModels: async (router) => (await import("../model-router/model-manager.js")).listModels(router),
  listRouters: async () => (await import("../model-router/model-manager.js")).listRouters(),
  readSetupSettings: async () => (await import("../setup/settings.js")).readSetupSettings(),
  listAdminUsers: async () => (await import("./auth.js")).listAdminUsers(),
  errorResponse: errResponse,
});

registerGuestChatRoutes(api, {
  requireUser,
  getSource: uploadSource,
  consumeAccess: (key, limit) => guestChatLimiter.consume(key, limit),
  accessLimit: readRuntimeLimits().guestAccessPerWindow,
  rateLimitResponse: guestChatRateLimitResponse,
  readConfig: () => {
    const { guestAiName, guestModel } = readRuntimeConfig();
    return { guestAiName, guestModel };
  },
  readDefaultModel: async () => {
    const { readSetupSettings } = await import("../setup/settings.js");
    const { model, apiRouter, maxContext } = readSetupSettings().defaultModel;
    return { model, apiRouter, maxContext };
  },
  ensureGuestChat: ({ userId, aiName, aiModel, apiRouter, maxContext }) =>
    ensureGuestChatAtomic({
      userId,
      aiName,
      aiModel,
      apiRouter,
      maxContext,
      settings: {
        userInterruptions: true,
        aiInterruptions: false,
        forceAiReply: false,
        loadedTools: ["read_tool_info"],
      },
      name: "guest chat",
    }),
  errorResponse: errResponse,
});

registerChatLifecycleRoutes(api, {
  requireUser,
  parseChatId: (value) => parseRouteId(value, "chat id"),
  isUserAuthorizedInChat,
  parseRenameBody: async (request) => {
    const bodyResult = renameChatSchema.safeParse(await request.json().catch(() => undefined));
    if (!bodyResult.success) throw new ValidationError("invalid chat name", bodyResult.error.flatten());
    return bodyResult.data;
  },
  getAppMeta,
  clearContext,
  renameChat,
  getChat,
  deleteChat,
  evictChat,
  errorResponse: errResponse,
});

registerParticipantRoutes(api, {
  requireUser,
  parseChatId: (value) => parseRouteId(value, "chat id"),
  parseParticipantId: (value) => parseRouteId(value, "participant id"),
  isUserAuthorizedInChat,
  parseAddBody: async (request) => {
    const bodyResult = addParticipantSchema.safeParse(await request.json().catch(() => undefined));
    if (!bodyResult.success) throw new ValidationError("invalid participant payload", bodyResult.error.flatten());
    return bodyResult.data;
  },
  parsePatchBody: async (request) => {
    const bodyResult = participantPatchSchema.safeParse(await request.json().catch(() => undefined));
    if (!bodyResult.success) throw new ValidationError("invalid participant payload", bodyResult.error.flatten());
    return bodyResult.data;
  },
  parseSettingsBody: async (request) => {
    const bodyResult = chatSettingsPatchSchema.safeParse(await request.json().catch(() => undefined));
    if (!bodyResult.success) throw new ValidationError("invalid chat settings payload", bodyResult.error.flatten());
    return bodyResult.data;
  },
  findUserByName: (name) => {
    const user = findUserByName(name);
    return user ? { id: user.id, name: user.name, image: user.image ?? undefined } : undefined;
  },
  getUserImage: (userId) => getUserImage(userId) ?? undefined,
  addParticipant: async (...args) => (await import("../chat/database.js")).addParticipant(...args),
  getParticipants: getParticipantsRows,
  updateAiParticipant: async (...args) => (await import("../chat/database.js")).updateAiParticipant(...args),
  getChat,
  evictChat,
  errorResponse: errResponse,
});

function errResponse(e: unknown): Response {
  const appErr = toAppError(e);
  const status =
    appErr.code === "unauthorized"
      ? 401
      : appErr.code === "not_found"
        ? 404
        : appErr.code === "validation_error"
          ? 400
          : appErr.code === "payload_too_large"
            ? 413
            : 500;
  return Response.json({ error: appErr.code, message: appErr.message }, { status });
}
