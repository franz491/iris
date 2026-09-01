import type { ChatEventPacket } from "./stream-routes.js";
import type { Message, Participant, ParticipantId } from "../chat/types.js";

export interface ReadabilityDeps {
  getParticipantsRows: (chatId: string) => Promise<Participant[]>;
  canReadMessage: (
    message: Pick<Message, "to" | "authorId" | "type">,
    viewerId: ParticipantId | null,
    roleOf: (participantId: string) => "user" | "ai" | undefined,
  ) => boolean;
}

function participantContext(participants: readonly Participant[], userId: string) {
  const viewer = participants.find((participant) => participant.role === "user" && participant.userId === userId);
  const roles = new Map(participants.map((participant) => [participant.id, participant.role] as const));
  return { viewerId: viewer?.id ?? null, roleOf: (id: string) => roles.get(id) };
}

export function createFilterReadable(deps: ReadabilityDeps) {
  return async (chatId: string, userId: string, messages: Message[]): Promise<Message[]> => {
    const participants = await deps.getParticipantsRows(chatId);
    const { viewerId, roleOf } = participantContext(participants, userId);
    return messages.filter((message) => deps.canReadMessage(message, viewerId, roleOf));
  };
}

export function createReadableChatEvent(deps: ReadabilityDeps) {
  return async (chatId: string, userId: string, clientId: string) => {
    const participants = await deps.getParticipantsRows(chatId);
    const { viewerId, roleOf } = participantContext(participants, userId);
    return (packet: ChatEventPacket): boolean => {
      if (packet.kind === "tool_request") {
        return packet.targetUserId === userId && packet.targetClientId === clientId;
      }
      if (packet.kind === "deleted") return packet.chatId === chatId;
      if (["routing", "stream", "done", "audio_ready", "truncated"].includes(packet.kind ?? "")) {
        if (!packet.recipientParticipantIds) return false;
        return packet.recipientParticipantIds.length === 0 || packet.recipientParticipantIds.includes(viewerId ?? "");
      }
      if (packet.kind === "message" || packet.kind === "branch_rewritten") {
        return packet.message !== undefined && deps.canReadMessage(packet.message, viewerId, roleOf);
      }
      return false;
    };
  };
}
