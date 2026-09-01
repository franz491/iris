import { describe, expect, it, vi } from "vitest";
import { buildGenerationContext } from "../src/chat/generation-context.js";
import type { ChatParticipantAi } from "../src/chat/types.js";

const ai = (name = "bot", threshold = 80): ChatParticipantAi =>
  ({ id: "ai-1", name, maxContext: 1_000, compactionThreshold: threshold }) as ChatParticipantAi;

function deps(participant: ChatParticipantAi, participants = 2) {
  return {
    getContext: vi.fn(async () => [{ role: "user" as const, content: "history" }]),
    getParticipants: vi.fn(async () =>
      Array.from({ length: participants }, (_, i) => ({ role: "user", id: `u-${i}` }) as never),
    ),
    buildLoadedToolsPrompt: vi.fn(() => "tool docs"),
    resolvePrompt: vi.fn(async (name: string) => `${name} prompt`),
    setupSummary: vi.fn(async () => "setup summary"),
  };
}

describe("generation context builder", () => {
  it("fuses system additions at the front while preserving non-system history", async () => {
    const d = deps(ai(), 3);
    const context = await buildGenerationContext(ai(), "ordinary", false, d);
    expect(context[0]?.role).toBe("system");
    expect(String(context[0]?.content)).toContain("tool docs");
    expect(String(context[0]?.content)).toContain("groupChat prompt");
    expect(String(context[0]?.content)).toContain("noReply prompt");
    expect(String(context[0]?.content)).toContain("importantInfo prompt");
    expect(context.at(-1)).toEqual({ role: "user", content: "history" });
  });

  it("omits the no-reply protocol when force-reply is enabled", async () => {
    const d = deps(ai(), 3);
    const context = await buildGenerationContext(ai(), "ordinary", true, d);
    expect(String(context[0]?.content)).not.toContain("noReply prompt");
    expect(d.resolvePrompt).toHaveBeenCalledWith("groupChat");
    expect(d.resolvePrompt).toHaveBeenCalledWith("importantInfo");
  });

  it("includes group protocol only for multi-participant chats", async () => {
    const d = deps(ai(), 2);
    const context = await buildGenerationContext(ai(), "ordinary", false, d);
    expect(String(context[0]?.content)).not.toContain("groupChat");
    expect(d.resolvePrompt).not.toHaveBeenCalledWith("groupChat");
  });

  it("adds the guided setup summary before the tool and protocol additions", async () => {
    const d = deps(ai("Iris Setup"), 3);
    const context = await buildGenerationContext(ai("Iris Setup"), "Iris guided setup", false, d);
    const content = String(context[0]?.content);
    expect(content.indexOf("setup summary")).toBeLessThan(content.indexOf("tool docs"));
    expect(d.setupSummary).toHaveBeenCalledOnce();
  });

  it("uses protocol fallbacks when prompt resolution returns empty values", async () => {
    const d = deps(ai(), 3);
    d.resolvePrompt.mockResolvedValue("");
    const context = await buildGenerationContext(ai(), "ordinary", false, d);
    expect(String(context[0]?.content)).toContain("This is a group chat");
    expect(String(context[0]?.content)).toContain("<no-reply>");
  });
});
