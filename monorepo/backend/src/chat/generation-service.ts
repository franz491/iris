import type { ToolConfig, ToolCallRequest } from "./tools.js";
import { buildOpenAiTools } from "./tools.js";
import { executeToolCall } from "./tool-loop-executor.js";
import { routeCompletion } from "../model-router/model-manager.js";
import type { ChatParticipantAi, ChatCompletionMessageParam, ParticipantId } from "./types.js";
import type { NewMessage } from "./message-service.js";
import type { GenerationHandle } from "./generation-coordinator.js";
import { buildGenerationContext } from "./generation-context.js";
import { collectGenerationStream } from "./generation-stream.js";
import { appendAssistantToolCalls, appendToolResult } from "./generation-tool-context.js";
import { finalizeGenerationReply } from "./generation-finalizer.js";
import type { ReplySegment } from "./utils.js";
import type { Participant } from "./types.js";

export interface GenerationServiceDeps {
  chatId: string;
  chatName: string;
  forceAiReply: boolean;
  historyRevision: () => number;
  getContext: (participant: ChatParticipantAi) => Promise<ChatCompletionMessageParam[]>;
  getParticipants: () => Promise<Participant[]>;
  buildLoadedToolsPrompt: () => string | null;
  resolvePrompt: (name: string) => Promise<string | null>;
  setupSummary: () => string | Promise<string>;
  effectiveToolConfig: () => ToolConfig;
  handleReadToolInfo: (rawArguments: string) => Promise<unknown>;
  requestFrontendTool: (call: ToolCallRequest, signal: AbortSignal) => Promise<unknown>;
  executeProviderTool: (call: ToolCallRequest) => Promise<unknown>;
  sendMessage: (message: NewMessage, silent: boolean) => Promise<unknown>;
  sendRouted: (
    participant: ChatParticipantAi,
    segments: ReplySegment[],
    options: { interrupted?: boolean },
  ) => Promise<ParticipantId[][]>;
  emit: (packet: unknown) => void;
  handleGeneratedAudio: (result: unknown, rawArguments: string, participantId: ParticipantId) => unknown;
  persistToolResult: (authorId: ParticipantId, toolName: string, result: unknown) => Promise<unknown>;
  onToolLoopExhausted: (participant: ChatParticipantAi) => void;
}

/** Own the bounded context/stream/tool iterations for one generation. */
export async function generateReply(
  participant: ChatParticipantAi,
  generation: GenerationHandle,
  deps: GenerationServiceDeps,
): Promise<number | undefined> {
  const revision = deps.historyRevision();
  const finalContext = await buildGenerationContext(participant, deps.chatName, deps.forceAiReply, {
    getContext: deps.getContext,
    getParticipants: deps.getParticipants,
    buildLoadedToolsPrompt: deps.buildLoadedToolsPrompt,
    resolvePrompt: deps.resolvePrompt,
    setupSummary: deps.setupSummary,
  });
  let extContext = [...finalContext];
  let latestPromptTokens: number | undefined;
  for (let i = 0; i < 8; i++) {
    if (revision !== deps.historyRevision()) return latestPromptTokens;
    // An interrupt can arrive after the coordinator starts this generation but
    // before the first provider call.  AbortSignal listeners do not fire when
    // attached after abort, so handle that boundary explicitly; otherwise an
    // already-cancelled generation would make a provider call and emit a
    // non-interrupted done packet.
    if (generation.signal.aborted) {
      // A rewrite/dispose cancellation must not attempt a stale write.  An
      // explicit stop, however, retains the user-visible interruption marker.
      if (generation.isStopRequested()) {
        await deps.sendMessage(
          {
            chatId: deps.chatId,
            authorId: participant.id,
            type: "text",
            thought: "",
            content: "- *<interrupted>*",
            to: undefined,
          },
          true,
        );
        deps.emit({ kind: "done", participantId: participant.id, interrupted: true, recipientParticipantIds: [] });
      }
      return latestPromptTokens;
    }
    let interrupted = false;
    generation.signal.addEventListener("abort", () => (interrupted = true), { once: true });
    try {
      const chunks = routeCompletion(participant, extContext, {
        stream: true,
        tools: buildOpenAiTools(deps.effectiveToolConfig()),
      });
      // A single human is the only audience that can possibly receive this
      // participant's reply.  Establish that scope before the first token so
      // it can be delivered live; group/ambiguous chats remain buffered until
      // reply routing has parsed the complete response.
      const participants = await deps.getParticipants();
      const humanIds = participants.filter((p) => p.role === "user").map((p) => p.id);
      const human = participants.find((p) => p.role === "user");
      // The universal guest participant is shared by unrelated sessions, so
      // its apparent single-user membership is not a safe audience boundary.
      const liveRecipient = humanIds.length === 1 && human?.userId !== "guest" ? humanIds : undefined;
      if (liveRecipient)
        deps.emit({
          kind: "routing",
          participantId: participant.id,
          recipientParticipantIds: liveRecipient,
          routingVersion: 1,
        });
      const streamed = await collectGenerationStream(
        chunks,
        generation.signal,
        participant.id,
        liveRecipient
          ? (chunk) =>
              deps.emit({
                kind: "stream",
                participantId: participant.id,
                chunk,
                recipientParticipantIds: liveRecipient,
              })
          : undefined,
      );
      latestPromptTokens = streamed.promptTokens ?? latestPromptTokens;
      const { segments, toolCalls, bufferedStream } = streamed;
      if (revision !== deps.historyRevision()) return latestPromptTokens;
      if (toolCalls.length === 0) {
        await finalizeGenerationReply({
          participantId: participant.id,
          segments,
          interrupted,
          bufferedStream: liveRecipient ? [] : bufferedStream,
          liveRecipientParticipantIds: liveRecipient,
          sendRouted: (replySegments, options) => deps.sendRouted(participant, replySegments, options),
          emit: deps.emit,
        });
        return latestPromptTokens;
      }
      await deps.sendMessage(
        {
          chatId: deps.chatId,
          authorId: participant.id,
          type: "tool",
          thought: segments
            .map((seg) => seg.thought)
            .filter(Boolean)
            .join("\n\n"),
          content: JSON.stringify(toolCalls),
          to: undefined,
        },
        true,
      );
      const toolExchange = appendAssistantToolCalls(extContext, participant.id, i, toolCalls);
      extContext = toolExchange.context;
      for (const [toolIndex, raw] of toolCalls.entries()) {
        let result = await executeToolCall(raw, generation.signal, {
          config: deps.effectiveToolConfig(),
          handleReadToolInfo: deps.handleReadToolInfo,
          requestFrontendTool: deps.requestFrontendTool,
          executeProviderTool: deps.executeProviderTool,
        });
        if (revision !== deps.historyRevision()) return latestPromptTokens;
        if (generation.signal.aborted) {
          if (generation.isStopRequested()) {
            await deps.sendMessage(
              {
                chatId: deps.chatId,
                authorId: participant.id,
                type: "text",
                thought: "",
                content: "- *<interrupted>*",
                to: undefined,
              },
              true,
            );
            deps.emit({ kind: "done", participantId: participant.id, interrupted: true, recipientParticipantIds: [] });
          }
          return latestPromptTokens;
        }
        result = deps.handleGeneratedAudio(result, raw.arguments, participant.id);
        await deps.persistToolResult(participant.id, raw.name, result);
        extContext = appendToolResult(extContext, toolExchange.callIds[toolIndex]!, result);
      }
    } finally {
      // The coordinator owns cancellation and removes the generation after the outer lifecycle completes.
    }
    if (interrupted) return latestPromptTokens;
  }
  deps.onToolLoopExhausted(participant);
  await deps.sendMessage(
    {
      chatId: deps.chatId,
      authorId: participant.id,
      type: "text",
      thought: "",
      content: "- <gave up after too many tool calls>",
      to: undefined,
    },
    true,
  );
  return latestPromptTokens;
}
