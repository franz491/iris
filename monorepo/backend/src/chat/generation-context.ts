import { systemMessagesFirst } from "./ai-participants.js";
import { DEFAULT_GROUP_CHAT_PROTOCOL, DEFAULT_NO_REPLY_PROTOCOL } from "./reply-router.js";
import type { ChatCompletionMessageParam, ChatParticipantAi, Participant } from "./types.js";

export interface GenerationContextDependencies {
  getContext: (participant: ChatParticipantAi) => Promise<ChatCompletionMessageParam[]>;
  getParticipants: () => Promise<Participant[]>;
  buildLoadedToolsPrompt: () => string | null;
  resolvePrompt: (name: string) => Promise<string | null>;
  setupSummary?: () => string | Promise<string>;
}

/** Assemble the initial model context; streaming and tool-loop state stay with ChatInstance. */
export async function buildGenerationContext(
  participant: ChatParticipantAi,
  chatName: string,
  forceAiReply: boolean,
  deps: GenerationContextDependencies,
): Promise<ChatCompletionMessageParam[]> {
  const context = await deps.getContext(participant);

  if (participant.name === "Iris Setup" && chatName === "Iris guided setup" && deps.setupSummary) {
    context.push({ role: "system", content: await deps.setupSummary() });
  }

  const toolDocs = deps.buildLoadedToolsPrompt();
  if (toolDocs) context.push({ role: "system", content: toolDocs });

  if ((await deps.getParticipants()).length > 2) {
    context.push({
      role: "system",
      content: (await deps.resolvePrompt("groupChat")) || DEFAULT_GROUP_CHAT_PROTOCOL,
    });
  }
  if (!forceAiReply) {
    context.push({
      role: "system",
      content: (await deps.resolvePrompt("noReply")) || DEFAULT_NO_REPLY_PROTOCOL,
    });
  }
  context.push({ role: "system", content: (await deps.resolvePrompt("importantInfo")) || "" });
  return systemMessagesFirst(context);
}
