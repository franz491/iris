import { describe, expect, it, vi } from "vitest";
import { createFilterReadable, createReadableChatEvent } from "../src/api/readability.js";
import type { Participant } from "../src/chat/types.js";

const participants = [
  { id: "alice-p", role: "user", name: "Alice", userId: "alice" },
  { id: "bot-p", role: "ai", name: "Bot", model: "m", apiRouter: "r" },
] as Participant[];

const canReadMessage = vi.fn((_message, viewerId, roleOf) => viewerId === "alice-p" && roleOf("bot-p") === "ai");

describe("readability boundaries", () => {
  it("filters history using one participant read and the viewer context", async () => {
    const getParticipantsRows = vi.fn(async () => participants);
    const filter = createFilterReadable({ getParticipantsRows, canReadMessage });
    const messages = [
      { id: "one", authorId: "bot-p", type: "text", to: undefined },
      { id: "two", authorId: "bot-p", type: "text", to: ["other"] },
    ] as never[];
    expect(await filter("chat", "alice", messages)).toEqual(messages);
    expect(getParticipantsRows).toHaveBeenCalledOnce();
  });

  it("captures SSE participant context once and fails closed for unknown events", async () => {
    const getParticipantsRows = vi.fn(async () => participants);
    const readable = createReadableChatEvent({ getParticipantsRows, canReadMessage });
    const canReceive = await readable("chat", "alice", "client");
    expect(getParticipantsRows).toHaveBeenCalledOnce();
    expect(canReceive({ kind: "tool_request", targetUserId: "alice", targetClientId: "client" })).toBe(true);
    expect(canReceive({ kind: "tool_request", targetUserId: "alice", targetClientId: "other" })).toBe(false);
    expect(canReceive({ kind: "deleted", chatId: "chat" })).toBe(true);
    expect(canReceive({ kind: "deleted", chatId: "other" })).toBe(false);
    expect(canReceive({ kind: "stream", recipientParticipantIds: [] })).toBe(true);
    expect(canReceive({ kind: "stream" })).toBe(false);
    expect(canReceive({ kind: "future_secret_event", payload: "secret" })).toBe(false);
  });

  it.each(["message", "branch_rewritten"])("delegates %s packet readability", async (kind) => {
    const readable = createReadableChatEvent({ getParticipantsRows: async () => participants, canReadMessage });
    const canReceive = await readable("chat", "alice", "client");
    expect(canReceive({ kind, message: { authorId: "bot-p", type: "text", to: [] } })).toBe(true);
    expect(canReceive({ kind })).toBe(false);
  });
});
