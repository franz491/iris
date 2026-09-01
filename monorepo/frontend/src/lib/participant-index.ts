export function indexParticipants<T extends { id: string }>(participants: T[]): Map<string, T> {
  return new Map(participants.map((participant) => [participant.id, participant] as const));
}
