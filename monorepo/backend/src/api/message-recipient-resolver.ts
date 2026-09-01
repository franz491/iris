import { UnauthorizedError, ValidationError } from "../misc/error.js";
import { mentionedParticipantIds } from "../chat/reply-router.js";
import type { AiParticipantBase, Participant, ParticipantId, UserParticipantBase } from "../chat/types.js";

export type MessageRecipientResolution = {
  author: UserParticipantBase;
  to?: ParticipantId[];
  targets: AiParticipantBase[];
};

/** Resolve message recipients from one consistent participant snapshot. */
export function resolveMessageRecipients(input: {
  content: string;
  explicitRecipients?: readonly string[];
  participants: readonly Participant[];
  userId: string;
}): MessageRecipientResolution {
  const participants = [...input.participants];
  let to: ParticipantId[] | undefined;
  if (input.explicitRecipients !== undefined) {
    const ids = new Set(participants.map((participant) => participant.id));
    if (input.explicitRecipients.some((id) => !ids.has(id))) {
      throw new ValidationError("to contains unknown participant ids");
    }
    // Preserve caller order while deduplicating before persistence. The
    // message-recipient join table has a composite key, so duplicate IDs
    // would otherwise turn an otherwise valid send into a database error.
    to = input.explicitRecipients.length > 0 ? [...new Set(input.explicitRecipients)] : undefined;
  }
  const mentioned = mentionedParticipantIds(input.content, participants);
  if (mentioned.length > 0) to = to ? [...new Set([...to, ...mentioned])] : mentioned;
  const author = participants.find(
    (participant): participant is UserParticipantBase =>
      participant.role === "user" && participant.userId === input.userId,
  );
  if (!author) throw new UnauthorizedError("not in this chat");
  const targets = participants.filter(
    (participant): participant is AiParticipantBase =>
      participant.role === "ai" && (!to || to.length === 0 || to.includes(participant.id)),
  );
  return { author, to, targets };
}
