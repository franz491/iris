// chat/auth.ts — verifies access to a chat based on frontend authentication.
import { and, eq } from "drizzle-orm";
import { chatDb as db } from "./database.js";
import { participants, userParticipants } from "./schema.js";
import type { ChatId, ParticipantId, UserId } from "./types.js";

/** The shared guest identity for unauthenticated sessions. */
export const GUEST_USER_ID = "guest";

/**
 * Whether the user participates in the chat (as any user participant).
 * Guests (unauthenticated) may access all chats that have no registered users.
 */
export async function isUserAuthorizedInChat(chatId: ChatId, userId: UserId): Promise<boolean> {
  const rows = await db
    .select({ userId: userParticipants.userId })
    .from(participants)
    .innerJoin(userParticipants, eq(userParticipants.participantId, participants.id))
    .where(and(eq(participants.chatId, chatId), eq(participants.type, "user")));
  const registered = rows.filter((r) => r.userId && r.userId !== GUEST_USER_ID);
  if (registered.length === 0) {
    // chat without real users: open to guests and members alike
    return userId === GUEST_USER_ID || rows.some((r) => r.userId === userId);
  }
  if (userId === GUEST_USER_ID) return false;
  return registered.some((r) => r.userId === userId);
}

/** Does the chat contain at least one registered ("real") user? */
export async function chatHasRegisteredUsers(chatId: ChatId): Promise<boolean> {
  const rows = await db
    .select({ userId: userParticipants.userId })
    .from(participants)
    .innerJoin(userParticipants, eq(userParticipants.participantId, participants.id))
    .where(and(eq(participants.chatId, chatId), eq(participants.type, "user")));
  return rows.some((r) => r.userId && r.userId !== GUEST_USER_ID);
}

/**
 * True if the given message/participant record belongs to this user:
 * participant.role === "user" && participant.userId === userId.
 */
export async function isUserAuthorizedRead(participantId: ParticipantId, userId: UserId): Promise<boolean> {
  const rows = await db
    .select({ userId: userParticipants.userId })
    .from(participants)
    .innerJoin(userParticipants, eq(userParticipants.participantId, participants.id))
    .where(eq(participants.id, participantId));
  const row = rows[0];
  return !!row && row.userId === userId;
}
