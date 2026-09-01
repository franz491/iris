import { describe, expect, it, vi } from "vitest";
import { compactAfterReply } from "../src/chat/compaction-service.js";
import { errorEvent } from "../src/misc/logging.js";
import type { ChatParticipantAi } from "../src/chat/types.js";

const participant = (threshold = 80, maxContext = 1_000): ChatParticipantAi =>
  ({ id: "ai-1", compactionThreshold: threshold, maxContext }) as ChatParticipantAi;

function dependencies(overrides: Partial<Parameters<typeof compactAfterReply>[2]> = {}) {
  return {
    progress: vi.fn(async () => ({ "ai-1": 0.9 })),
    compact: vi.fn(async () => undefined),
    onStarted: vi.fn(),
    onCompacted: vi.fn(),
    onFailed: vi.fn(),
    ...overrides,
  };
}

describe("compaction service", () => {
  it("does not compact below the measured-token threshold", async () => {
    const deps = dependencies();
    await compactAfterReply(participant(80, 1_000), 799, deps);
    expect(deps.progress).not.toHaveBeenCalled();
    expect(deps.compact).not.toHaveBeenCalled();
    expect(deps.onStarted).not.toHaveBeenCalled();
  });

  it("uses measured tokens and emits started, compact, completed in order", async () => {
    const order: string[] = [];
    const deps = dependencies({
      onStarted: () => order.push("started"),
      compact: async () => order.push("compact"),
      onCompacted: () => order.push("compacted"),
    });
    await compactAfterReply(participant(80, 1_000), 800, deps);
    expect(order).toEqual(["started", "compact", "compacted"]);
    expect(deps.progress).not.toHaveBeenCalled();
  });

  it("falls back to injected progress when usage is not measured", async () => {
    const deps = dependencies({ progress: vi.fn(async () => ({ "ai-1": 0.8 })) });
    await compactAfterReply(participant(80), undefined, deps);
    expect(deps.progress).toHaveBeenCalledOnce();
    expect(deps.compact).toHaveBeenCalledOnce();
  });

  it("contains compaction failures and reports only a redacted structured error", async () => {
    const failure = new Error('apiKey="secret" password=pw token=tok');
    const serialized: string[] = [];
    const deps = dependencies({
      compact: vi.fn(async () => {
        throw failure;
      }),
      onFailed: (error) =>
        serialized.push(JSON.stringify(errorEvent("chat", "compaction.failed", "failed", undefined, error))),
    });
    await expect(compactAfterReply(participant(80), 900, deps)).resolves.toBeUndefined();
    expect(deps.onCompacted).not.toHaveBeenCalled();
    expect(serialized[0]).toContain('"event":"compaction.failed"');
    expect(serialized[0]).not.toMatch(/secret|password=pw|token=tok/);
  });

  it("contains a failing diagnostic sink without changing the primary outcome", async () => {
    const deps = dependencies({
      onFailed: () => {
        throw new Error("sink failed");
      },
    });
    await expect(
      compactAfterReply(participant(80), 900, {
        ...deps,
        compact: vi.fn(async () => {
          throw new Error("compaction failed");
        }),
      }),
    ).resolves.toBeUndefined();
  });
});
