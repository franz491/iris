import { describe, expect, it, vi } from "vitest";
import { persistToolResult, toolResultMessage } from "../src/chat/generation-tool-result.js";
import type { Message } from "../src/chat/types.js";

const stored = { id: "m-1", createdAt: new Date(0) } as Message;

describe("generation tool result persistence", () => {
  it("builds the existing bounded silent tool-result message", () => {
    const message = toolResultMessage("chat-1", "ai-1", "files.read", { ok: true });
    expect(message).toEqual({
      chatId: "chat-1",
      authorId: "ai-1",
      type: "tool_result",
      thought: "",
      content: '{"tool":"files.read","result":{"ok":true}}',
      to: undefined,
    });
  });

  it("preserves the 16,000-character serialization bound", () => {
    const message = toolResultMessage("chat-1", "ai-1", "tool", { payload: "x".repeat(20_000) });
    expect(message.content).toHaveLength(16_000);
    expect(message.content).not.toContain("raw-secret-after-boundary");
  });

  it("keeps legacy UTF-16 character slicing rather than changing to a byte cap", () => {
    const result = { payload: "🙂".repeat(10_000) };
    const expected = JSON.stringify({ tool: "tool", result }).slice(0, 16_000);
    expect(toolResultMessage("chat-1", "ai-1", "tool", result).content).toBe(expected);
    expect(expected).toHaveLength(16_000);
  });

  it("propagates JSON serialization failures for cyclic and BigInt results", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => toolResultMessage("chat-1", "ai-1", "tool", cyclic)).toThrow(TypeError);
    expect(() => toolResultMessage("chat-1", "ai-1", "tool", 1n)).toThrow(TypeError);
  });

  it("injects persistence and preserves metadata/order", async () => {
    const persist = vi.fn(async (message): Promise<Message> => {
      expect(message.type).toBe("tool_result");
      expect(message.content).toContain('"tool":"tool"');
      return stored;
    });
    await expect(persistToolResult("chat-1", "ai-1", "tool", { value: 3 }, { persist })).resolves.toBe(stored);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.invocationCallOrder[0]).toBeGreaterThan(0);
  });

  it("propagates persistence failure without logging or fabricating success", async () => {
    const persist = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    await expect(persistToolResult("chat-1", "ai-1", "tool", { secret: "apiKey" }, { persist })).rejects.toThrow(
      "database unavailable",
    );
    expect(persist).toHaveBeenCalledOnce();
  });
});
