// chat/polling.ts — polling functionality.
import { getMessagesSinceId as dbGetMessagesSinceId, getUserChatMemberships } from "./database.js";

import type { ChatId, Message, MessageId, ParticipantId, UserId } from "./types.js";

/** Messages for a chat since lastMessage, max 500. */
export async function getMessagesSinceId(
  chat: ChatId,
  _participantId: ParticipantId,
  lastMessage: MessageId,
): Promise<Message[]> {
  return dbGetMessagesSinceId(chat, lastMessage);
}

export interface ChatSummary {
  id: string;
  createdAt: Date;
  name?: string;
}

/**
 * All chats the user belongs to that are "new to them" since the timestamp:
 * either created after it, or the user was added after it.
 * ("Pull all my chats since yesterday", including old chats newly joined.)
 */
export async function getChatsSinceTimestamp(userId: UserId, timestamp: number): Promise<ChatSummary[]> {
  const memberships = await getUserChatMemberships(userId);
  const relevant = memberships.filter((m) => m.chatCreatedAt >= timestamp || m.addedAt >= timestamp);
  if (relevant.length === 0) return [];
  return relevant
    .map((m) => ({
      id: m.chatId,
      createdAt: new Date(Math.min(m.chatCreatedAt, m.addedAt)),
      name: m.chatName ?? undefined,
    }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, 1000);
}
