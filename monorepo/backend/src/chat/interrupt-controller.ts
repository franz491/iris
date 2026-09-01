import {
  GenerationCoordinator,
  type GenerationCompletion,
  type GenerationHandle,
  type GenerationIntent,
} from "./generation-coordinator.js";
import type { ParticipantId } from "./types.js";

/** Own generation cancellation and history invalidation for one chat instance. */
export class InterruptController {
  private readonly coordinator = new GenerationCoordinator();
  private revision = 0;

  historyRevision(): number {
    return this.revision;
  }

  /** Invalidate in-flight context and cancel every generation after a rewrite. */
  rewriteHistory(): number {
    this.revision++;
    this.coordinator.cancelAll();
    return this.revision;
  }

  start(participantId: ParticipantId): GenerationHandle | undefined {
    return this.coordinator.start(participantId);
  }

  request(participantId: ParticipantId, intent: GenerationIntent): boolean {
    return this.coordinator.request(participantId, intent);
  }

  complete(participantId: ParticipantId): GenerationCompletion {
    return this.coordinator.complete(participantId);
  }

  cancel(participantId: ParticipantId): void {
    this.coordinator.cancel(participantId);
  }

  cancelAll(): void {
    this.coordinator.cancelAll();
  }

  participants(): ParticipantId[] {
    return this.coordinator.participants();
  }
}
