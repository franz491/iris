import type { ParticipantId } from "./types.js";

export type GenerationIntent = "interrupt" | "stop";

export interface GenerationHandle {
  readonly participantId: ParticipantId;
  readonly signal: AbortSignal;
  readonly generationId: number;
  readonly isStopRequested: () => boolean;
}

export interface GenerationCompletion {
  readonly restart: boolean;
  readonly stopRequested: boolean;
}

/** Owns the short-lived state for one generation per AI participant. */
export class GenerationCoordinator {
  private nextId = 1;
  private readonly active = new Map<
    ParticipantId,
    {
      id: number;
      controller: AbortController;
      intent?: GenerationIntent;
    }
  >();

  start(participantId: ParticipantId): GenerationHandle | undefined {
    if (this.active.has(participantId)) return undefined;
    const entry = {
      id: this.nextId++,
      controller: new AbortController(),
      intent: undefined as GenerationIntent | undefined,
    };
    this.active.set(participantId, entry);
    return {
      participantId,
      generationId: entry.id,
      signal: entry.controller.signal,
      isStopRequested: () => entry.intent === "stop",
    };
  }

  request(participantId: ParticipantId, intent: GenerationIntent): boolean {
    const entry = this.active.get(participantId);
    if (!entry) return false;
    // An explicit stop must not be converted into an auto-restarting
    // interruption by a concurrent message arriving before cleanup finishes.
    if (entry.intent === "stop") return true;
    entry.intent = intent;
    entry.controller.abort();
    return true;
  }

  complete(participantId: ParticipantId): GenerationCompletion {
    const entry = this.active.get(participantId);
    if (!entry) return { restart: false, stopRequested: false };
    this.active.delete(participantId);
    return { restart: entry.intent === "interrupt", stopRequested: entry.intent === "stop" };
  }

  cancel(participantId: ParticipantId): void {
    const entry = this.active.get(participantId);
    if (!entry) return;
    entry.controller.abort();
    this.active.delete(participantId);
  }

  cancelAll(): void {
    for (const entry of this.active.values()) entry.controller.abort();
    this.active.clear();
  }

  has(participantId: ParticipantId): boolean {
    return this.active.has(participantId);
  }

  participants(): ParticipantId[] {
    return [...this.active.keys()];
  }
}
