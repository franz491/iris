import type { Participant, ParticipantId } from "./types.js";

export type RoutedReply = { content: string; to?: ParticipantId[] };

export interface ReplyRoutingOptions {
  forceAiReply?: boolean;
}

export const DEFAULT_GROUP_CHAT_PROTOCOL =
  "This is a group chat. Normal text is public. A paragraph containing exact @names from the participant " +
  "list is private to those participants. Keep all tags visible; unknown tags remain text. Only the literal " +
  "<new-message> tag starts a separate message; a blank line alone does not split anything.";

export const DEFAULT_NO_REPLY_PROTOCOL =
  "If no reply would be useful, output exactly <no-reply>. It must be the entire response.";

/** Resolve exact @participant names anywhere in text, preserving the text. */
export function mentionedParticipantIds(text: string, participants: Participant[]): ParticipantId[] {
  const tokens = [...text.matchAll(/@([^\s@<>]+)/g)].flatMap((m) => {
    const raw = m[1].toLowerCase();
    const withoutSentencePunctuation = raw.replace(/[.,!?;:]+$/, "");
    return raw === withoutSentencePunctuation ? [raw] : [raw, withoutSentencePunctuation];
  });
  const wanted = new Set(tokens);
  return participants.filter((p) => wanted.has(p.name.toLowerCase())).map((p) => p.id);
}

/** Route a completed reply into public or participant-scoped messages. */
export function routeReply(
  content: string,
  participants: Participant[],
  options: ReplyRoutingOptions = {},
): RoutedReply[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];
  if (!options.forceAiReply && /^<?\s*no-?\s*reply\s*>?$/i.test(trimmed)) return [];

  const paragraphs = trimmed
    .split(/<new-message>\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return (paragraphs.length > 0 ? paragraphs : [trimmed]).map((para) => {
    const ids = mentionedParticipantIds(para, participants);
    return { content: para, to: ids.length > 0 ? ids : undefined };
  });
}

export function audienceForAiMessage(to: ParticipantId[] | undefined, participants: Participant[]): ParticipantId[] {
  if (!to?.length) return [];
  const roles = new Map(participants.map((participant) => [participant.id, participant.role] as const));
  if (to.every((id) => roles.get(id) === "ai")) return [];
  return [...new Set(to.filter((id) => roles.get(id) === "user"))].sort();
}

export function stripAiNamePrefix(content: string, name: string): string {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`^\\s*(?:${escaped}|${escaped.replace(/\s+/g, "[-_]?")})\\s*:\\s*`, "i"), "");
}
