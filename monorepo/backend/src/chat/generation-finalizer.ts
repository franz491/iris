import type { ParticipantId } from "./types.js";
import type { ReplySegment } from "./utils.js";

export interface FinalizerPacket {
  [key: string]: unknown;
}

export interface GenerationFinalizerDeps {
  participantId: ParticipantId;
  segments: ReplySegment[];
  interrupted: boolean;
  bufferedStream: readonly FinalizerPacket[];
  sendRouted: (segments: ReplySegment[], options: { interrupted: boolean }) => Promise<ParticipantId[][]>;
  emit: (packet: unknown) => void;
  liveRecipientParticipantIds?: ParticipantId[];
}

function uniformRecipientScope(scopes: ParticipantId[][]): ParticipantId[] | undefined {
  if (scopes.length === 0) return undefined;
  const first = scopes[0]!;
  return scopes.every((scope) => scope.length === first.length && scope.every((id, index) => id === first[index]))
    ? first
    : undefined;
}

function lifecycleRecipientScope(scopes: ParticipantId[][]): ParticipantId[] {
  if (scopes.length === 0 || scopes.some((scope) => scope.length === 0)) return [];
  return [...new Set(scopes.flat())].sort();
}

/** Replay safely scoped buffered packets and finish one generation response. */
export async function finalizeGenerationReply(deps: GenerationFinalizerDeps): Promise<void> {
  const messageScopes = await deps.sendRouted(deps.segments, { interrupted: deps.interrupted });
  const uniformScope = uniformRecipientScope(messageScopes);
  // An empty uniform scope is the explicit public-broadcast scope used by
  // ChatInstance; mixed scopes remain suppressed for confidentiality.
  if (uniformScope) {
    for (const packet of deps.bufferedStream) {
      deps.emit({ ...packet, recipientParticipantIds: uniformScope });
    }
  }
  deps.emit({
    kind: "done",
    participantId: deps.participantId,
    interrupted: deps.interrupted,
    recipientParticipantIds: deps.liveRecipientParticipantIds ?? lifecycleRecipientScope(messageScopes),
  });
}
