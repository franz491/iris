import { beforeEach, describe, expect, it, vi } from "vitest";
import { GenerationCoordinator } from "../src/chat/generation-coordinator.js";
import { generateReply } from "../src/chat/generation-service.js";
import type { ChatParticipantAi } from "../src/chat/types.js";
import type { Participant } from "../src/chat/types.js";

const { routeCompletion } = vi.hoisted(() => ({ routeCompletion: vi.fn() }));
vi.mock("../src/model-router/model-manager.js", () => ({ routeCompletion }));

const participant = {
  id: "ai-1",
  chatId: "chat-1",
  role: "ai",
  name: "Assistant",
  createdAt: new Date(0),
  addedAt: new Date(0),
  model: "model",
  apiRouter: "router",
  apiAdditionalFields: {},
  readsOthersThoughts: false,
  prompt: "",
  willReplyPrompt: "",
  maxContext: 4096,
  compactionThreshold: 80,
} satisfies ChatParticipantAi;

describe("generation service", () => {
  beforeEach(() => routeCompletion.mockReset());
  function deps(participants: Participant[], emit = vi.fn()) {
    return {
      chatId: participant.chatId,
      chatName: "Chat",
      forceAiReply: false,
      historyRevision: () => 0,
      getContext: async () => [],
      getParticipants: async () => participants,
      buildLoadedToolsPrompt: () => null,
      resolvePrompt: async () => null,
      setupSummary: async () => "",
      effectiveToolConfig: () => ({ tools: [], promptOverrides: {} }),
      handleReadToolInfo: async () => ({}),
      requestFrontendTool: async () => ({}),
      executeProviderTool: async () => ({}),
      sendMessage: vi.fn(async () => undefined),
      sendRouted: vi.fn(async () => participants.filter((p) => p.role === "user").map((p) => [p.id])),
      emit,
      handleGeneratedAudio: (result: unknown) => result,
      persistToolResult: async () => undefined,
      onToolLoopExhausted: () => undefined,
    };
  }

  const user = {
    id: "user-1",
    chatId: "chat-1",
    role: "user",
    name: "User",
    userId: "account-1",
    createdAt: new Date(0),
    addedAt: new Date(0),
  } satisfies Participant;

  it("emits routing before live chunks and does not replay them", async () => {
    routeCompletion.mockReturnValue(
      (async function* () {
        yield { delta: "hello" };
        yield { delta: " world" };
      })(),
    );
    const emitted: unknown[] = [],
      d = deps([participant, user], (p) => emitted.push(p));
    await generateReply(participant, new GenerationCoordinator().start(participant.id)!, d);
    expect(emitted).toEqual([
      { kind: "routing", participantId: "ai-1", recipientParticipantIds: ["user-1"], routingVersion: 1 },
      { kind: "stream", participantId: "ai-1", chunk: { delta: "hello" }, recipientParticipantIds: ["user-1"] },
      { kind: "stream", participantId: "ai-1", chunk: { delta: " world" }, recipientParticipantIds: ["user-1"] },
      { kind: "done", participantId: "ai-1", interrupted: false, recipientParticipantIds: ["user-1"] },
    ]);
  });

  it("keeps the live audience on terminal done even when final routing is empty", async () => {
    routeCompletion.mockReturnValue(
      (async function* () {
        yield { delta: "@Assistant private" };
      })(),
    );
    const emitted: unknown[] = [],
      d = deps([participant, user], (p) => emitted.push(p));
    d.sendRouted.mockResolvedValue([]);
    await generateReply(participant, new GenerationCoordinator().start(participant.id)!, d);
    expect((emitted.at(-1) as any).recipientParticipantIds).toEqual(["user-1"]);
  });

  it.each([
    [[user, { ...user, id: "user-2", userId: "account-2" }], "multi-human"],
    [[participant], "ai-only"],
    [[participant, { ...user, userId: "guest" }], "guest"],
  ])("buffers %s chats until final routing", async (participants, _label) => {
    routeCompletion.mockReturnValue(
      (async function* () {
        yield { delta: "hidden" };
      })(),
    );
    const emitted: unknown[] = [],
      d = deps(participants as Participant[], (p) => emitted.push(p));
    await generateReply(participant, new GenerationCoordinator().start(participant.id)!, d);
    expect(emitted.some((p: any) => p.kind === "routing")).toBe(false);
  });

  it("never live-emits tool-call fragments", async () => {
    routeCompletion.mockReturnValue(
      (async function* () {
        yield { toolCallDeltas: [{ index: 0, id: "c", name: "x", arguments: "{}" }] };
      })(),
    );
    const emitted: unknown[] = [],
      d = deps([participant, user], (p) => emitted.push(p));
    await generateReply(participant, new GenerationCoordinator().start(participant.id)!, d);
    expect(emitted.filter((p: any) => p.kind === "stream")).toEqual([]);
  });
  it("drops an interrupt that arrives before the first provider call without stale writes", async () => {
    const coordinator = new GenerationCoordinator();
    const generation = coordinator.start(participant.id)!;
    coordinator.request(participant.id, "interrupt");
    const sendMessage = vi.fn(async () => undefined);
    const emit = vi.fn();

    await generateReply(participant, generation, {
      chatId: participant.chatId,
      chatName: "Chat",
      forceAiReply: false,
      historyRevision: () => 0,
      getContext: async () => [],
      getParticipants: async () => [participant],
      buildLoadedToolsPrompt: () => null,
      resolvePrompt: async () => null,
      setupSummary: async () => "",
      effectiveToolConfig: () => ({ tools: [], promptOverrides: {} }),
      handleReadToolInfo: async () => ({}),
      requestFrontendTool: async () => ({}),
      executeProviderTool: async () => ({}),
      sendMessage,
      sendRouted: async () => [],
      emit,
      handleGeneratedAudio: (result) => result,
      persistToolResult: async () => undefined,
      onToolLoopExhausted: () => undefined,
    });

    expect(routeCompletion).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
});
