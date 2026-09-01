// lib/types.ts — shapes returned by the backend API.

export interface ChatSettings {
  userInterruptions: boolean;
  aiInterruptions: boolean;
  /** require a response instead of allowing the no-reply protocol */
  forceAiReply?: boolean;
}

export interface ChatSummary {
  id: string;
  createdAt: string;
  name?: string;
}

export interface Participant {
  id: string;
  chatId: string;
  role: "user" | "ai";
  name: string;
  createdAt: string;
  addedAt?: string;
  // AI participants:
  model?: string;
  cardId?: string;
  prompt?: string;
  apiKeyName?: string;
  compactionThreshold?: number;
  readsOthersThoughts?: boolean;
  maxContext?: number;
  // User participants:
  userId?: string;
  avatar?: string;
}

export interface Message {
  id: string;
  chatId: string;
  authorId: string;
  type: "tool" | "text" | "file" | "tool_result" | "compaction";
  thought: string;
  content: string;
  createdAt: string;
  /** per-chat insertion sequence (pagination cursor) */
  seq?: number;
  to?: string[];
}

export interface AiCard {
  id: string;
  name: string;
  model: string;
  apiRouter: string;
  maxContext: number;
  prompt: string;
  avatarSeed?: string;
  avatar?: string;
  createdAt: string;
}
