import { describe, expect, it } from "vitest";
import { resolveMessageRecipients } from "../src/api/message-recipient-resolver.js";
import type { Participant } from "../src/chat/types.js";

const participants = [
  { id: "user", role: "user", name: "Alice", userId: "alice" },
  { id: "bot-a", role: "ai", name: "A", model: "m", apiRouter: "r" },
  { id: "bot-b", role: "ai", name: "B", model: "m", apiRouter: "r" },
  { id: "bob", role: "user", name: "Bob", userId: "bob" },
] as Participant[];

describe("message recipient resolver", () => {
  it("resolves the author and broadcasts when recipients are omitted or empty", () => {
    expect(resolveMessageRecipients({ content: "hello", participants, userId: "alice" })).toMatchObject({
      author: { id: "user" },
      to: undefined,
      targets: [{ id: "bot-a" }, { id: "bot-b" }],
    });
    expect(
      resolveMessageRecipients({ content: "hello", explicitRecipients: [], participants, userId: "alice" }).targets,
    ).toHaveLength(2);
  });

  it("validates explicit recipients and merges mentions with stable deduplication", () => {
    const result = resolveMessageRecipients({
      content: "@B hi @A",
      explicitRecipients: ["bot-a", "bot-b", "bot-a"],
      participants,
      userId: "alice",
    });
    expect(result.to).toEqual(["bot-a", "bot-b"]);
    expect(result.targets.map((target) => target.id)).toEqual(["bot-a", "bot-b"]);
    expect(() =>
      resolveMessageRecipients({ content: "hello", explicitRecipients: ["missing"], participants, userId: "alice" }),
    ).toThrow("to contains unknown participant ids");
  });

  it("deduplicates explicit recipients even when there are no mentions", () => {
    const result = resolveMessageRecipients({
      content: "hello",
      explicitRecipients: ["bot-b", "bot-a", "bot-b"],
      participants,
      userId: "alice",
    });
    expect(result.to).toEqual(["bot-b", "bot-a"]);
    expect(result.targets.map((target) => target.id)).toEqual(["bot-a", "bot-b"]);
  });

  it("keeps unknown mentions as ordinary content and routes known user mentions", () => {
    const result = resolveMessageRecipients({ content: "@nobody @Bob hello", participants, userId: "alice" });
    expect(result.to).toEqual(["bob"]);
    expect(result.targets).toEqual([]);
  });

  it("rejects when the sender has no matching user participant", () => {
    expect(() => resolveMessageRecipients({ content: "hello", participants, userId: "mallory" })).toThrow(
      "not in this chat",
    );
  });
});
