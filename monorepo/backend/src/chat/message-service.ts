import type { ChatParticipantAi, Message, Participant } from "./types.js";

export type NewMessage = Omit<Message, "id" | "createdAt">;

export interface MessageServiceDeps {
  persist: (message: NewMessage) => Promise<Message>;
  publish: (packet: unknown) => void;
  getParticipants: () => Promise<Participant[]>;
  schedule: (participant: ChatParticipantAi, sender: Participant | undefined) => void | Promise<void>;
  onScheduleError?: (error: unknown, participant: ChatParticipantAi) => void;
}

/** Persist a message, publish it, and optionally schedule eligible AI replies. */
export async function persistPublishAndSchedule(
  message: NewMessage,
  silent: boolean,
  deps: MessageServiceDeps,
): Promise<Message> {
  const stored = await deps.persist(message);
  deps.publish({ kind: "message", message: stored });
  if (silent) return stored;

  const participants = await deps.getParticipants();
  const sender = participants.find((participant) => participant.id === message.authorId);
  const targets = participants.filter(
    (participant) =>
      participant.role === "ai" &&
      participant.id !== message.authorId &&
      (!message.to || message.to.length === 0 || message.to.includes(participant.id)),
  );
  for (const target of targets) {
    if (target.role !== "ai") continue;
    try {
      const pending = deps.schedule(target, sender);
      if (pending && typeof (pending as Promise<void>).then === "function") {
        void pending.catch((error: unknown) => deps.onScheduleError?.(error, target));
      }
    } catch (error) {
      deps.onScheduleError?.(error, target);
    }
  }
  return stored;
}
