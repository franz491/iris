import type { ChatParticipantAi, ParticipantId } from "./types.js";

export interface CompactionServiceDependencies {
  progress: () => Promise<Record<ParticipantId, number>>;
  compact: () => Promise<void>;
  onStarted: () => void;
  onCompacted: () => void;
  onFailed: (error: unknown) => void;
}

/** Apply the threshold policy around compaction while keeping side effects injectable. */
export async function compactAfterReply(
  participant: ChatParticipantAi,
  measuredPromptTokens: number | undefined,
  deps: CompactionServiceDependencies,
): Promise<void> {
  try {
    const usage =
      measuredPromptTokens == null
        ? ((await deps.progress())[participant.id] ?? 0)
        : Math.min(1, measuredPromptTokens / Math.max(1, participant.maxContext));
    if (usage * 100 < participant.compactionThreshold) return;
    deps.onStarted();
    await deps.compact();
    deps.onCompacted();
  } catch (error) {
    // Failure reporting is deliberately isolated: diagnostics must not turn a
    // completed generation into a second operational failure.
    try {
      deps.onFailed(error);
    } catch {
      // The caller's primary operation remains contained even if its sink fails.
    }
  }
}
