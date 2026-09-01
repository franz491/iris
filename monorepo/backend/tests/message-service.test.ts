import { describe, expect, it } from "vitest";
import { persistPublishAndSchedule, type MessageServiceDeps, type NewMessage } from "../src/chat/message-service.js";
import type { ChatParticipantAi, Message, Participant } from "../src/chat/types.js";

const message: NewMessage = {
  chatId: "chat-1",
  authorId: "user-1",
  type: "text",
  thought: "",
  content: "hello",
};
const user = { id: "user-1", role: "user", name: "user" } as Participant;
const ai1 = { id: "ai-1", role: "ai", name: "one" } as ChatParticipantAi;
const ai2 = { id: "ai-2", role: "ai", name: "two" } as ChatParticipantAi;

function deps(
  events: string[],
  participants: Participant[] = [user, ai1, ai2],
): MessageServiceDeps & { stored: Message } {
  const stored = { ...message, id: "message-1", createdAt: new Date(0), seq: 1 } as Message;
  return {
    stored,
    persist: async (next: NewMessage) => {
      events.push(`persist:${next.content}`);
      return stored;
    },
    publish: (packet: unknown) => {
      expect((packet as { kind: string }).kind).toBe("message");
      events.push("publish");
    },
    getParticipants: async () => {
      events.push("participants");
      return participants;
    },
    schedule: (participant: ChatParticipantAi, sender: Participant | undefined) => {
      events.push(`schedule:${participant.id}:${sender?.id}`);
    },
  };
}

describe("message service", () => {
  it("persists, publishes, then schedules eligible AIs in order", async () => {
    const events: string[] = [];
    const d = deps(events);
    await expect(persistPublishAndSchedule(message, false, d)).resolves.toBe(d.stored);
    expect(events).toEqual([
      "persist:hello",
      "publish",
      "participants",
      "schedule:ai-1:user-1",
      "schedule:ai-2:user-1",
    ]);
  });

  it("does not inspect participants or schedule when silent", async () => {
    const events: string[] = [];
    const d = deps(events);
    await persistPublishAndSchedule(message, true, d);
    expect(events).toEqual(["persist:hello", "publish"]);
  });

  it("does not publish or schedule after persistence failure", async () => {
    const events: string[] = [];
    const d = deps(events);
    d.persist = async () => {
      events.push("persist");
      throw new Error("db unavailable");
    };
    await expect(persistPublishAndSchedule(message, false, d)).rejects.toThrow("db unavailable");
    expect(events).toEqual(["persist"]);
  });

  it("filters sender, unknown recipients, and preserves explicit recipient scope", async () => {
    const events: string[] = [];
    const d = deps(events, [ai1, ai2, user, { id: "other", role: "user", name: "other" } as Participant]);
    await persistPublishAndSchedule({ ...message, to: ["ai-2", "other"] }, false, d);
    expect(events).toEqual(["persist:hello", "publish", "participants", "schedule:ai-2:user-1"]);
  });

  it("contains synchronous and asynchronous scheduler failures after publication", async () => {
    const events: string[] = [];
    const errors: string[] = [];
    const d = deps(events);
    d.onScheduleError = (error, participant) => errors.push(`${participant.id}:${(error as Error).message}`);
    d.schedule = (participant) => {
      events.push(`schedule:${participant.id}`);
      if (participant.id === "ai-1") throw new Error("sync scheduler failure");
      return Promise.reject(new Error("async scheduler failure"));
    };

    await expect(persistPublishAndSchedule(message, false, d)).resolves.toBe(d.stored);
    await Promise.resolve();
    expect(errors).toEqual(["ai-1:sync scheduler failure", "ai-2:async scheduler failure"]);
    expect(events.slice(0, 3)).toEqual(["persist:hello", "publish", "participants"]);
  });

  it("keeps publication ordering when participant lookup fails", async () => {
    const events: string[] = [];
    const d = deps(events);
    d.getParticipants = async () => {
      events.push("participants");
      throw new Error("participant lookup failed");
    };

    await expect(persistPublishAndSchedule(message, false, d)).rejects.toThrow("participant lookup failed");
    expect(events).toEqual(["persist:hello", "publish", "participants"]);
  });
});
