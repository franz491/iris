// chat/types.ts
// All IDs are strings; all are UUIDs except ModelId.

export type ChatId = string;
export type ParticipantId = string;
export type UserId = string;
export type MessageId = string;
export type ModelId = string;

/** OpenAI-style multimodal content part (vision inputs). */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

/** ChatContext = OpenAI chat-completion message param shape (kept structural to avoid a hard dep here). */
export interface ChatCompletionMessageParam {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}
export type ChatContext = ChatCompletionMessageParam[];

export interface Chat {
  id: ChatId;
  participants: Participant[];
  createdAt: Date;
  name?: string;
}

export interface ParticipantBase<Role extends "ai" | "user"> {
  chatId: ChatId;
  role: Role;
  id: ParticipantId;
  name: string;
  createdAt: Date;
  /** when this participant joined the chat */
  addedAt: Date;
}

export interface AiParticipantBase extends ParticipantBase<"ai"> {
  model: ModelId;
  /** e.g. "llamacpp" or "openai-compat" */
  apiRouter: string;
  apiAdditionalFields: Record<string, unknown>;
  readsOthersThoughts: boolean;
  /** AI card this participant was created from, if any */
  cardId?: string;
  prompt: string;
  willReplyPrompt: string;
  lastCompactedMessageId?: MessageId;
  compactedContext?: string;
  maxContext: number;
  /** percentage of the context budget at which auto-compaction triggers */
  compactionThreshold: number;
  /** named API key reference; the key itself lives in the admin-managed keys store */
  apiKeyName?: string;
}

export interface UserParticipantBase extends ParticipantBase<"user"> {
  userId?: UserId;
  /** pfp data URI; identicon fallback */
  avatar?: string;
}

export type Participant = AiParticipantBase | UserParticipantBase;
export type ChatParticipantAi = AiParticipantBase;
export type ChatParticipantUser = UserParticipantBase;

export type MessageType = "tool" | "text" | "file" | "tool_result" | "compaction";

export interface Message {
  id: MessageId;
  chatId: ChatId;
  authorId: ParticipantId;
  type: MessageType;
  thought: string;
  content: string;
  createdAt: Date;
  /** per-chat insertion sequence (internal; timestamps can tie) */
  seq?: number;
  /** empty array or undefined means "all" */
  to?: ParticipantId[];
}

export interface ChatStream {
  stream: AsyncIterable<unknown>;
  recipients?: ParticipantId[];
}

export interface WillReply {
  thought?: string;
  value: boolean;
  recipients?: ParticipantId[];
  reason?: string;
}

/** Chat-level settings (kept in-memory per chat; extend as needed). */
export interface ChatSettings {
  /** allow user messages to interrupt a replying AI */
  userInterruptions: boolean;
  /** allow AI messages to interrupt a replying AI */
  aiInterruptions: boolean;
  /** require a response instead of allowing the no-reply protocol */
  forceAiReply?: boolean;
  /** tool groups loaded into the AI context (always includes read_tool_info) */
  loadedTools?: string[];
}
