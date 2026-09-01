import { describe, expect, it, vi } from "vitest";
import { finalizeGenerationReply } from "../src/chat/generation-finalizer.js";

const segments = [{ content: "answer", thought: "" }];
const packet = { kind: "stream", chunk: { delta: "answer" } };

async function run(scopes: string[][], bufferedStream = [packet]) {
  const emitted: unknown[] = [];
  const sendRouted = vi.fn(async () => scopes);
  await finalizeGenerationReply({
    participantId: "ai-1",
    segments,
    interrupted: false,
    bufferedStream,
    sendRouted,
    emit: (value) => emitted.push(value),
  });
  return { emitted, sendRouted };
}

describe("generation response finalizer", () => {
  it("replays every buffered packet for one uniform nonempty audience", async () => {
    const { emitted, sendRouted } = await run(
      [
        ["user-b", "user-a"],
        ["user-b", "user-a"],
      ],
      [packet, { ...packet }],
    );
    expect(sendRouted).toHaveBeenCalledWith(segments, { interrupted: false });
    expect(emitted).toEqual([
      { ...packet, recipientParticipantIds: ["user-b", "user-a"] },
      { ...packet, recipientParticipantIds: ["user-b", "user-a"] },
      { kind: "done", participantId: "ai-1", interrupted: false, recipientParticipantIds: ["user-a", "user-b"] },
    ]);
  });

  it("suppresses buffered packets for mixed scopes but replays explicit public scope", async () => {
    await expect(run([["user-a"], ["user-b"]])).resolves.toMatchObject({
      emitted: [{ kind: "done", recipientParticipantIds: ["user-a", "user-b"] }],
    });
    await expect(run([[]])).resolves.toMatchObject({
      emitted: [
        { ...packet, recipientParticipantIds: [] },
        { kind: "done", recipientParticipantIds: [] },
      ],
    });
  });

  it("deduplicates and sorts the lifecycle scope", async () => {
    const { emitted } = await run(
      [
        ["user-c", "user-a"],
        ["user-c", "user-b"],
      ],
      [],
    );
    expect(emitted).toEqual([
      {
        kind: "done",
        participantId: "ai-1",
        interrupted: false,
        recipientParticipantIds: ["user-a", "user-b", "user-c"],
      },
    ]);
  });

  it("passes interruption through and emits exactly one done packet", async () => {
    const emitted: unknown[] = [];
    const sendRouted = vi.fn(async (_segments, options) => {
      expect(options).toEqual({ interrupted: true });
      return [["user-a"]];
    });
    await finalizeGenerationReply({
      participantId: "ai-1",
      segments,
      interrupted: true,
      bufferedStream: [],
      sendRouted,
      emit: (value) => emitted.push(value),
    });
    expect(emitted).toEqual([
      { kind: "done", participantId: "ai-1", interrupted: true, recipientParticipantIds: ["user-a"] },
    ]);
  });

  it("propagates routing failure and emits nothing", async () => {
    const emit = vi.fn();
    await expect(
      finalizeGenerationReply({
        participantId: "ai-1",
        segments,
        interrupted: false,
        bufferedStream: [packet],
        sendRouted: async () => {
          throw new Error("persist failed");
        },
        emit,
      }),
    ).rejects.toThrow("persist failed");
    expect(emit).not.toHaveBeenCalled();
  });
});
