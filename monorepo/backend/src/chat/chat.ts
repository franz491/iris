// chat/chat.ts — chat functionality.
import {
  createChatAtomic,
  getChatRow,
  getParticipantsRows,
  insertMessage,
  loadChatSettings,
  saveChatSettings,
  rewriteMessageBranch,
  getMessagesSinceId as dbGetMessagesSinceId,
  countUserParticipants,
  type NewParticipant,
} from "./database.js";
import { resolvePrompt } from "../prompts/library.js";
import { type ReplySegment, newMessageId } from "./utils.js";
import {
  executeProviderTool,
  loadToolDocs,
  aiGroupName,
  TOOL_GROUPS,
  ALWAYS_LOADED_GROUPS,
  type ToolConfig,
  type ToolSetting,
  type ToolCallRequest,
  DEFAULT_TIMEOUT_MS,
} from "./tools.js";
import { readRuntimeLimits } from "../config/runtime-limits.js";
import type {
  Chat,
  ChatId,
  ChatParticipantAi,
  ChatSettings,
  Message,
  MessageId,
  Participant,
  ParticipantId,
} from "./types.js";
import { errorEvent, eventRecord, logger, pseudonym } from "../misc/logging.js";
import { observeGeneration } from "../misc/generation-observer.js";
import { discardTransientAudio, registerTransientAudio } from "../api/transient-audio.js";
import { cacheAudio } from "../admin/audio-cache.js";
import { getAdminConfig } from "../admin/store.js";
import type { GenerationHandle } from "./generation-coordinator.js";
import { InterruptController } from "./interrupt-controller.js";
import { EventBroker } from "./event-broker.js";
import { audienceForAiMessage, mentionedParticipantIds, routeReply, stripAiNamePrefix } from "./reply-router.js";
import { persistPublishAndSchedule } from "./message-service.js";
import { InstanceCache } from "./instance-cache.js";
import type { ModelAdmissionLease } from "../api/model-admission.js";
import { FrontendToolWaitRegistry } from "./frontend-tool-wait.js";
import { FrontendToolConfigRegistry } from "./frontend-tool-config-registry.js";
import { compactAfterReply } from "./compaction-service.js";
import { handleGeneratedAudio } from "./generation-audio-handler.js";
import { persistToolResult } from "./generation-tool-result.js";
import { generateReply as generateReplyService } from "./generation-service.js";

const log = logger("chat");

function parseProviderArguments(rawArguments: string): Record<string, unknown> {
  if (typeof rawArguments !== "string") return {};
  if (Buffer.byteLength(rawArguments, "utf8") > readRuntimeLimits().toolArgumentBytes) return {};
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const DEFAULT_SETTINGS: ChatSettings = {
  userInterruptions: true,
  aiInterruptions: false,
  forceAiReply: false,
  loadedTools: ["read_tool_info"],
};

export class ChatInstance {
  readonly id: ChatId;
  readonly name: string;
  settings: ChatSettings;
  private readonly events: EventBroker<unknown>;
  /** AI participants currently generating a reply */
  private readonly interruptions = new InterruptController();
  private activeOperations = 0;
  private disposed = false;

  /** True only when no caller, subscriber, generation, or tool wait owns this instance. */
  isCacheIdle(): boolean {
    return (
      !this.disposed &&
      this.activeOperations === 0 &&
      this.events.size() === 0 &&
      this.interruptions.participants().length === 0 &&
      this.pendingToolRequests.size === 0 &&
      this.frontendToolConfigs.size === 0
    );
  }

  private beginActivity(): () => void {
    this.activeOperations++;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeOperations--;
      instances.trim();
    };
  }

  constructor(chat: Chat, settings?: Partial<ChatSettings>) {
    this.id = chat.id;
    this.name = chat.name ?? "";
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.events = new EventBroker((error) => {
      log.error(
        JSON.stringify(
          errorEvent("chat", "subscriber.failed", "subscriber_failed", undefined, error, {
            chat_ref: pseudonym(this.id),
          }),
        ),
      );
    });
    this.pendingToolRequests = new FrontendToolWaitRegistry(newMessageId, {
      onTimeout: (timeoutMs) => {
        log.warn(
          JSON.stringify(
            eventRecord(
              "chat",
              "tool_wait.timeout",
              { outcome: "timeout", durationMs: timeoutMs, chat_ref: pseudonym(this.id) },
              "warn",
            ),
          ),
        );
      },
    });
  }

  /** Notify subscribers that this chat was deleted (before teardown). */
  emitDeleted(): void {
    this.emit({ kind: "deleted", chatId: this.id });
  }

  /** Cancel all work owned by this live instance; safe to call repeatedly. */
  dispose(reason = "chat instance disposed"): void {
    if (this.disposed) return;
    this.disposed = true;
    // Resolve waits before aborting generations so callers receive the
    // lifecycle reason instead of the generic provider cancellation message.
    this.cancelPendingToolRequests(reason);
    this.interruptions.cancelAll();
    this.frontendToolConfigs.clear();
    this.events.clear();
  }

  /** Update chat settings and persist them (survives restarts). */
  async setSettings(patch: Partial<ChatSettings>): Promise<ChatSettings> {
    const done = this.beginActivity();
    try {
      this.settings = { ...this.settings, ...patch };
      await saveChatSettings(this.id, this.settings);
      return this.settings;
    } finally {
      done();
    }
  }

  async getParticipants(): Promise<Participant[]> {
    return getParticipantsRows(this.id);
  }

  async getMessagesSinceId(_participantId: ParticipantId, lastMessage: MessageId): Promise<Message[]> {
    return dbGetMessagesSinceId(this.id, lastMessage);
  }

  /**
   * Subscribe to streams; receives each packet as argument. Returns an
   * unsubscribe function.
   */
  subscribe(fn: (packet: unknown) => void): () => void {
    const unsubscribe = this.events.subscribe(fn);
    return () => {
      unsubscribe();
      instances.trim();
    };
  }

  /**
   * Explicit live-stream boundary. Producers may use this only after they
   * have independently established the audience; the routing frame is always
   * published before the first content frame. The current model path does not
   * call this because @mention routing is only known after completion and
   * therefore continues using buffered replay.
   */
  async emitScopedStream(
    participantId: ParticipantId,
    recipientParticipantIds: ParticipantId[],
    chunk: Record<string, unknown>,
  ): Promise<void> {
    const done = this.beginActivity();
    try {
      const participants = await this.getParticipants();
      if (!participants.some((p) => p.id === participantId && p.role === "ai"))
        throw new Error("invalid stream participant");
      const valid = new Set(participants.filter((p) => p.role === "user").map((p) => p.id));
      const scope = [...new Set(recipientParticipantIds)].sort();
      if (scope.length === 0 || scope.some((id) => !valid.has(id))) throw new Error("invalid stream recipient scope");
      this.emit({ kind: "routing", participantId, recipientParticipantIds: scope, routingVersion: 1 });
      this.emit({ kind: "stream", participantId, chunk, recipientParticipantIds: scope });
    } finally {
      done();
    }
  }

  emit(packet: unknown): void {
    this.events.emit(packet);
  }

  /**
   * Add the message to the DB, then ping AI participants (excluding the
   * sender). If silent, only persist.
   */
  async sendMessage(
    message: Omit<Message, "id" | "createdAt">,
    silent = false,
    admission?: ModelAdmissionLease[],
  ): Promise<Message> {
    if (this.disposed) throw new Error("chat instance disposed");
    const done = this.beginActivity();
    try {
      let result: Message;
      try {
        result = await persistPublishAndSchedule(message, silent, {
          persist: (next) => insertMessage(next),
          publish: (packet) => this.emit(packet),
          getParticipants: () => this.getParticipants(),
          schedule: (participant, sender) => {
            // fire-and-forget; interruption logic lives in pingAiParticipant
            const lease = admission?.shift();
            void this.pingAiParticipant(participant, sender, lease);
          },
        });
      } catch (error) {
        for (const lease of admission ?? []) lease.release();
        throw error;
      }
      for (const lease of admission ?? []) lease.release();
      return result;
    } finally {
      done();
    }
  }

  /** Rewrite one message, discard its old branch, and optionally regenerate. */
  async rewriteHistory(
    messageId: MessageId,
    patch: { content?: string; thought?: string },
  ): Promise<{ message: Message; deletedFollowing: number; regenerating: boolean }> {
    const done = this.beginActivity();
    try {
      this.interruptions.rewriteHistory();
      const result = await rewriteMessageBranch(this.id, messageId, patch);
      this.emit({
        kind: "branch_rewritten",
        chatId: this.id,
        message: result.message,
        deletedFollowing: result.deletedFollowing,
      });
      const participants = await this.getParticipants();
      const author = participants.find((p) => p.id === result.message.authorId);
      const regenerating = author?.role === "user";
      if (regenerating) {
        const targets = participants.filter(
          (p) =>
            p.role === "ai" &&
            (!result.message.to || result.message.to.length === 0 || result.message.to.includes(p.id)),
        );
        for (const target of targets) void this.pingAiParticipant(target as ChatParticipantAi, author);
      }
      return { ...result, regenerating };
    } finally {
      done();
    }
  }

  /** Send one streamed completion and persist its routed response. */
  async pingAiParticipant(
    participant: ChatParticipantAi,
    sender?: Participant,
    admission?: ModelAdmissionLease,
  ): Promise<void> {
    if (this.disposed) {
      admission?.release();
      return;
    }
    const done = this.beginActivity();
    try {
      const generation = this.interruptions.start(participant.id);
      if (!generation) {
        admission?.release();
        // A new message arrived while this AI is replying.
        const parts = await this.getParticipants();
        const senderPart = sender ?? parts.find((p) => p.id === participant.id)!;
        if (this.interruptAiParticipant(senderPart, participant)) {
          this.interruptions.request(participant.id, "interrupt");
        }
        return;
      }
      try {
        await observeGeneration(
          async () => {
            const promptTokens = await this.generateReply(participant, generation);
            await this.maybeCompact(participant, promptTokens);
          },
          undefined,
          { isCancelled: () => generation.signal.aborted },
        );
      } catch (e) {
        log.error(
          JSON.stringify(
            errorEvent("chat", "generation.failed", "generation_failed", undefined, e, {
              chat_ref: pseudonym(this.id),
              actor_ref: pseudonym(participant.id),
            }),
          ),
        );
      } finally {
        const completion = this.interruptions.complete(participant.id);
        let transferred = false;
        try {
          if (completion.restart) {
            // A restart is a new generation, but retains the reservation until
            // that generation finishes so it cannot bypass admission.
            const fresh = (await this.getParticipants()).find((p) => p.id === participant.id);
            if (fresh && fresh.role === "ai") {
              transferred = true;
              void this.pingAiParticipant(fresh, undefined, admission);
            }
          }
        } finally {
          if (!transferred) admission?.release();
          instances.trim();
        }
      }
    } finally {
      done();
    }
  }

  private readonly pendingToolRequests: FrontendToolWaitRegistry;
  private readonly frontendToolConfigs = new FrontendToolConfigRegistry(readRuntimeLimits().chatToolConfigEntries);

  setToolConfig(
    userId: string,
    clientId: string,
    cfg: Omit<ToolConfig, "promptOverrides"> & { promptOverrides?: Record<string, string> },
  ): void {
    const frontendTools = cfg.tools.filter((t) => TOOL_GROUPS[t.tool]?.flavor === "frontend");
    this.frontendToolConfigs.upsert({
      userId,
      clientId,
      config: { tools: frontendTools, promptOverrides: cfg.promptOverrides },
      updatedAt: Date.now(),
    });
    instances.trim();
  }

  removeToolConfig(userId: string, clientId: string): void {
    this.frontendToolConfigs.remove(userId, clientId);
    instances.trim();
  }

  /**
   * Effective active groups: the FE machine overlay plus everything loaded
   * into the chat via read_tool_info / the settings modal.
   */
  effectiveToolConfig(): ToolConfig {
    const base: ToolConfig = { tools: [], promptOverrides: {} };
    for (const t of this.settings.loadedTools ?? []) {
      if (TOOL_GROUPS[t]) base.tools.push({ tool: t });
    }
    return this.frontendToolConfigs.effectiveToolConfig(base, TOOL_GROUPS);
  }

  /** Groups whose docs are currently loaded into the AI context. */
  loadedGroups(): string[] {
    return this.frontendToolConfigs.loadedGroups(this.settings.loadedTools ?? [], ALWAYS_LOADED_GROUPS, TOOL_GROUPS);
  }

  /** Send streamed reply segments. Each segment carries ITS OWN thinking
   *  block (think/talk alternation -> multiple messages). Paragraph splits
   *  within one segment keep the block only on the first part (no cloning). */
  private async sendRouted(
    participant: ChatParticipantAi,
    segments: ReplySegment[],
    opts: { interrupted?: boolean } = {},
  ): Promise<ParticipantId[][]> {
    let routedAny = false;
    let lastThought = "";
    const messageScopes: ParticipantId[][] = [];
    const participants = await this.getParticipants();
    for (const seg of segments) {
      if (this.disposed) return messageScopes;
      if (!seg.content.trim()) {
        if (seg.thought) lastThought = seg.thought;
        continue;
      }
      routedAny = true;
      const suffix = opts.interrupted ? "\n\n- *<interrupted>*" : "";
      const finalThought = opts.interrupted && seg.thought ? `${seg.thought}\n\n- *<interrupted>*` : seg.thought;
      const withoutName = stripAiNamePrefix(seg.content, participant.name);
      const routed = routeReply(withoutName + suffix, participants, { forceAiReply: this.settings.forceAiReply });
      for (const [ri, msg] of routed.entries()) {
        await this.sendMessage(
          {
            chatId: this.id,
            authorId: participant.id,
            type: "text",
            thought: ri === 0 ? finalThought : "",
            content: msg.content,
            to: msg.to,
          },
          true,
        );
        messageScopes.push(audienceForAiMessage(msg.to, participants));
      }
    }
    // interrupted before ANY output (e.g. still thinking): persist just the
    // interruption marker so the stop is visible in the chat
    if (opts.interrupted && !routedAny) {
      await this.sendMessage(
        {
          chatId: this.id,
          authorId: participant.id,
          type: "text",
          thought: lastThought ? `${lastThought}\n\n- *<interrupted>*` : "",
          content: "- *<interrupted>*",
          to: undefined,
        },
        true,
      );
      messageScopes.push([]);
    }
    return messageScopes;
  }

  /**
   * System prompt with only generic tool.md descriptions. Detailed function
   * docs enter context through read_tool_info results and can be requested
   * again if compaction later removes them.
   */
  buildLoadedToolsPrompt(cfg: ToolConfig): string | null {
    const groups = this.loadedGroups();
    if (groups.length === 0) return null;
    const parts: string[] = [];
    for (const g of groups) {
      const def = TOOL_GROUPS[g];
      const docs = loadToolDocs(g, cfg.promptOverrides);
      const section = [`# tool: ${aiGroupName(def)}`, docs.tool].filter(Boolean).join("\n");
      parts.push(section);
    }
    return [
      "You have access to the following tools. Only their functions that are",
      "listed below are callable; call read_tool_info(tools:[...]) to load more.",
      "Tools prefixed backend_ run on the server; unprefixed tools run locally",
      "on the user's machine.",
      "",
      ...parts,
    ].join("\n");
  }

  /** read_tool_info execution: load groups + return their full docs. */
  async handleReadToolInfo(rawArguments: string): Promise<unknown> {
    if (typeof rawArguments !== "string") return { error: "invalid arguments JSON" };
    const maxArgumentBytes = readRuntimeLimits().toolArgumentBytes;
    if (Buffer.byteLength(rawArguments, "utf8") > maxArgumentBytes) {
      return { error: `arguments JSON exceeds ${maxArgumentBytes} bytes` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArguments || "{}");
    } catch {
      return { error: "invalid arguments JSON" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "arguments JSON must be an object" };
    }
    const tools = (parsed as { tools?: unknown }).tools;
    if (tools !== undefined && (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string"))) {
      return { error: "arguments JSON tools must be an array of strings" };
    }
    const requested = (tools as string[] | undefined) ?? [];
    const byAiName = new Map<string, string>([["read_tool_info", "read_tool_info"]]);
    for (const [key, g] of Object.entries(TOOL_GROUPS)) byAiName.set(aiGroupName(g), key);
    const valid = [...new Set(requested.map((t) => byAiName.get(t)).filter((t): t is string => Boolean(t)))];
    const unknown = requested.filter((t) => !byAiName.has(t));
    // persist so they stay loaded for the rest of the chat
    const loaded = await this.setLoadedGroups([...new Set([...(this.settings.loadedTools ?? []), ...valid])]);
    const docs: Record<string, unknown> = {};
    for (const g of valid) docs[g] = loadToolDocs(g, this.effectiveToolConfig().promptOverrides);
    return { loaded, unknownTools: unknown.length > 0 ? unknown : undefined, docs };
  }

  /** Load/unload tool groups for the rest of the chat and persist. */
  async setLoadedGroups(groups: string[]): Promise<string[]> {
    const valid = groups.filter((g) => TOOL_GROUPS[g]);
    // always-loaded groups are implicit; keep them out of the stored list
    this.settings.loadedTools = valid.filter((g) => !ALWAYS_LOADED_GROUPS.includes(g));
    await saveChatSettings(this.id, this.settings);
    return this.loadedGroups();
  }

  /** Resolve a pending frontend tool request. Returns false if none matches. */
  resolveToolRequest(
    requestId: string,
    responder: { userId: string; clientId: string },
    result: { approved: boolean; result?: unknown; error?: string },
  ): boolean {
    const resolved = this.pendingToolRequests.resolve(requestId, responder, result);
    if (resolved) instances.trim();
    return resolved;
  }

  /** Cancel all pending frontend waits during chat/process teardown. */
  cancelPendingToolRequests(reason = "tool request cancelled"): void {
    this.pendingToolRequests.cancelAll(reason);
    instances.trim();
  }

  /**
   * Hand a tool to the connected FE for execution (and optional approval).
   * Approval timeout: setting.approvalTimeoutMs ?? 120s; 0 waits forever.
   */
  private async requestFrontendTool(call: ToolCallRequest, signal: AbortSignal): Promise<unknown> {
    if (typeof call.arguments !== "string") {
      return { approved: false, error: "invalid arguments JSON" };
    }
    const maxArgumentBytes = readRuntimeLimits().toolArgumentBytes;
    if (Buffer.byteLength(call.arguments, "utf8") > maxArgumentBytes) {
      return { approved: false, error: `arguments JSON exceeds ${maxArgumentBytes} bytes` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments || "{}");
    } catch {
      return { approved: false, error: "invalid arguments JSON" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { approved: false, error: "arguments JSON must be an object" };
    }
    const args = parsed as Record<string, unknown>;
    const requestedUser = String(args.target_user ?? "")
      .replace(/^@/, "")
      .toLowerCase();
    delete args.target_user;
    if (call.name === "audio_play") args._chatId = this.id;
    const participants = await this.getParticipants();
    const userNames = new Map<string, string>();
    for (const p of participants) if (p.role === "user" && p.userId) userNames.set(p.userId, p.name);
    const candidates = [...this.frontendToolConfigs.values()]
      .map((ad) => ({ ad, setting: ad.config.tools.find((t) => t.tool === call.groupDef.name) }))
      .filter((x): x is { ad: typeof x.ad; setting: ToolSetting } => Boolean(x.setting));
    const eligibleUsers = [...new Set(candidates.map((x) => x.ad.userId))];
    if (eligibleUsers.length === 0) {
      return {
        approved: false,
        error: `${aiGroupName(call.groupDef)} is not configured on any connected user's device; ask a user to enable edit_settings or open tool settings manually`,
      };
    }
    let targetUserId: string | undefined;
    if (requestedUser) {
      targetUserId = eligibleUsers.find(
        (id) => id === requestedUser || userNames.get(id)?.toLowerCase() === requestedUser,
      );
      if (!targetUserId) {
        return {
          approved: false,
          error: `target_user is not eligible; choose one of: ${eligibleUsers.map((id) => userNames.get(id) ?? id).join(", ")}`,
        };
      }
    } else if (eligibleUsers.length === 1) {
      targetUserId = eligibleUsers[0];
    } else {
      return {
        approved: false,
        error: `multiple humans have this local tool; retry with target_user set to one of: ${eligibleUsers.map((id) => userNames.get(id) ?? id).join(", ")}`,
      };
    }
    const selected = candidates
      .filter((x) => x.ad.userId === targetUserId)
      .sort((a, b) => b.ad.updatedAt - a.ad.updatedAt)[0];
    const timeoutMs = selected.setting.approvalTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (signal.aborted) return { approved: false, error: "generation cancelled" };
    const pending = this.pendingToolRequests.wait({
      userId: selected.ad.userId,
      clientId: selected.ad.clientId,
      timeoutMs,
      signal,
      emit: (requestId) =>
        this.emit({
          kind: "tool_request",
          participantId: call.name ? undefined : undefined,
          requestId,
          tool: call.name,
          arguments: args,
          requiresApproval: selected.setting.requiresApproval ?? false,
          timeoutMs,
          targetUserId: selected.ad.userId,
          targetClientId: selected.ad.clientId,
        }),
    });
    return pending.promise;
  }

  /** Participant ids with a reply currently being generated. */
  replyingParticipants(): ParticipantId[] {
    return this.interruptions.participants();
  }

  /**
   * Stop button: saves the truncated reply suffixed "- *<interrupted>*" like
   * an interrupt does, but does NOT restart generation afterwards, and
   * ignores the per-chat interruption settings (explicit user action).
   * Returns false when the AI was not generating.
   */
  stopAiParticipant(participantId: ParticipantId): boolean {
    return this.interruptions.request(participantId, "stop");
  }

  /** Invalidate generations whose context may include a deleted branch. */
  invalidateHistory(): void {
    this.interruptions.rewriteHistory();
  }

  private async generateReply(
    participant: ChatParticipantAi,
    generation: GenerationHandle,
  ): Promise<number | undefined> {
    return generateReplyService(participant, generation, {
      chatId: this.id,
      chatName: this.name,
      forceAiReply: this.settings.forceAiReply ?? false,
      historyRevision: () => this.interruptions.historyRevision(),
      getContext: (ai) => import("./ai-participants.js").then(({ getContextForAi }) => getContextForAi(this.id, ai)),
      getParticipants: () => this.getParticipants(),
      buildLoadedToolsPrompt: () => this.buildLoadedToolsPrompt(this.effectiveToolConfig()),
      resolvePrompt,
      setupSummary: async () => {
        const { setupCurrentSummary } = await import("../admin/setup-tools.js");
        return setupCurrentSummary();
      },
      effectiveToolConfig: () => this.effectiveToolConfig(),
      handleReadToolInfo: (rawArguments) => this.handleReadToolInfo(rawArguments),
      requestFrontendTool: (call, signal) => this.requestFrontendTool(call, signal),
      executeProviderTool: (call) => executeProviderTool(call, { chatId: this.id }),
      sendMessage: (message, silent) => this.sendMessage(message, silent),
      sendRouted: (ai, segments, options) => this.sendRouted(ai, segments, options),
      emit: (packet) => this.emit(packet),
      handleGeneratedAudio: (result, rawArguments, participantId) => {
        const args = parseProviderArguments(rawArguments);
        const cache = getAdminConfig().config.cache;
        return handleGeneratedAudio(
          result,
          {
            text: typeof args.text === "string" ? args.text : "",
            language: typeof args.language === "string" ? args.language : undefined,
            voice: typeof args.voice === "string" ? args.voice : undefined,
            style: typeof args.instruct === "string" ? args.instruct : undefined,
            chatId: this.id,
          },
          {
            cache,
            cacheAudio,
            registerTransientAudio,
            discardTransientAudio,
            emitAudioReady: (token) =>
              this.emit({ kind: "audio_ready", participantId, token, recipientParticipantIds: [] }),
          },
        );
      },
      persistToolResult: (authorId, toolName, result) =>
        persistToolResult(this.id, authorId, toolName, result, {
          persist: (message) => this.sendMessage(message, true),
        }),
      onToolLoopExhausted: (ai) =>
        log.error(
          JSON.stringify(
            errorEvent(
              "chat",
              "tool_loop.exhausted",
              "tool_loop_limit",
              undefined,
              new Error("tool loop exceeded limit"),
              {
                chat_ref: pseudonym(this.id),
                actor_ref: pseudonym(ai.id),
              },
            ),
          ),
        ),
    });
  }
  /** Based on chat settings, may the sender interrupt the replying AI? */
  interruptAiParticipant(sender: Participant, _talking: ChatParticipantAi): boolean {
    if (sender.role === "user") return this.settings.userInterruptions;
    return this.settings.aiInterruptions;
  }

  /**
   * Auto-compaction: after each successful reply, compact when context usage
   * is at or above the participant's configured threshold percentage.
   */
  private async maybeCompact(participant: ChatParticipantAi, measuredPromptTokens?: number): Promise<void> {
    return compactAfterReply(participant, measuredPromptTokens, {
      progress: async () => {
        const { compactionProgress } = await import("./ai-participants.js");
        return compactionProgress(this.id, [participant]);
      },
      compact: async () => {
        const { compactChat } = await import("./ai-participants.js");
        await compactChat(participant);
      },
      onStarted: () => {
        log.info(
          JSON.stringify(
            eventRecord("chat", "compaction.started", {
              outcome: "threshold",
              chat_ref: pseudonym(this.id),
              actor_ref: pseudonym(participant.id),
            }),
          ),
        );
        // surface it so users understand the AI may briefly "forget"
        this.emit({ kind: "compacting", participantId: participant.id, name: participant.name });
      },
      onCompacted: () => this.emit({ kind: "compacted", participantId: participant.id, name: participant.name }),
      onFailed: (error) =>
        log.error(
          JSON.stringify(
            errorEvent("chat", "compaction.failed", "compaction_failed", undefined, error, {
              chat_ref: pseudonym(this.id),
              actor_ref: pseudonym(participant.id),
            }),
          ),
        ),
    });
  }
}

// ---------- module-level API ----------

/**
 * One live instance per chat so subscribers (e.g. SSE streams) and senders
 * share the same event bus. Instances are cheap; the DB is always the source
 * of truth for history.
 */
const instances = new InstanceCache<ChatId, ChatInstance>({
  maxEntries: readRuntimeLimits().chatInstanceCacheEntries,
  isIdle: (instance) => instance.isCacheIdle(),
});

export async function getChat(chatId: ChatId, chatSettings?: Partial<ChatSettings>): Promise<ChatInstance> {
  return instances.get(chatId, async () => {
    const row = await getChatRow(chatId);
    const stored = await loadChatSettings(chatId);
    return new ChatInstance(row, { ...stored, ...chatSettings });
  });
}

export async function createChat(
  participants: NewParticipant[],
  chatSettings?: Partial<ChatSettings>,
  name?: string,
): Promise<ChatInstance> {
  const chatId = createChatAtomic(participants, { ...DEFAULT_SETTINGS, ...chatSettings }, name);
  const full = await getChatRow(chatId);
  const instance = new ChatInstance(full, { ...DEFAULT_SETTINGS, ...chatSettings });
  instances.set(chatId, instance);
  return instance;
}

/** Drop the live instance for a deleted chat (memory-leak guard). */
export function evictChat(chatId: ChatId): void {
  instances.evict(chatId, "chat instance evicted");
}
export function cancelAllPendingToolRequests(reason = "process shutting down"): void {
  instances.disposeAll(reason);
}

/** Wipe a chat's context: DB messages/compaction + drop the live instance. */
export async function clearContext(chatId: ChatId): Promise<void> {
  instances.evict(chatId, "chat context cleared");
  const { clearChatContext } = await import("./database.js");
  await clearChatContext(chatId);
}

export { countUserParticipants };
export { mentionedParticipantIds };
