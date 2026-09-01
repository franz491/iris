import { describe, expect, it, vi } from "vitest";
import { normalizeChatCreation, createChatSchema } from "../src/api/chat-creation-service.js";

const deps = {
  getUserName: () => "Owner",
  findUserByName: (name: string) => (name === "alice" ? { id: "alice-id", name: "Alice", image: "avatar" } : null),
  readSetupSettings: () => ({
    defaultModel: { model: "default-model", apiRouter: "llamacpp", maxContext: 8192, apiKeyName: "default-key" },
  }),
  listRouters: () => ["llamacpp", "openai-compat"],
  modelContextWindow: vi.fn(async () => 16384),
  createChat: vi.fn(async () => ({ id: "chat-id" })),
};

describe("chat creation service", () => {
  it("keeps the creator first, resolves users, deduplicates humans, and preserves AI order", async () => {
    const result = await normalizeChatCreation(
      "owner-id",
      {
        participants: [
          { role: "user", name: "alice@iris.local" },
          { role: "user", name: "alice" },
          { role: "ai", name: "one" },
          { role: "ai", name: "two" },
        ],
        settings: { userInterruptions: false, unknown: true } as never,
        name: "  chat  ",
      },
      deps,
    );
    expect(result.participants.map((p) => p.role + ":" + p.name)).toEqual([
      "user:Owner",
      "user:Alice",
      "ai:one",
      "ai:two",
    ]);
    expect(result.settings).toEqual({ userInterruptions: false });
    expect(result.name).toBe("chat");
    expect(deps.modelContextWindow).toHaveBeenCalledTimes(2);
  });

  it("uses discovered context and default API key only for the configured model", async () => {
    const result = await normalizeChatCreation(
      "owner-id",
      { participants: [{ role: "ai" }, { role: "ai", model: "other" }] },
      deps,
    );
    expect(result.participants[1]).toMatchObject({
      model: "default-model",
      maxContext: 16384,
      apiKeyName: "default-key",
    });
    expect(result.participants[2]).toMatchObject({ model: "other", maxContext: 16384 });
    expect(result.participants[2]).toHaveProperty("apiKeyName", undefined);
  });

  it("rejects unknown routers and user impersonation before creation", async () => {
    await expect(
      normalizeChatCreation("owner-id", { participants: [{ role: "ai", apiRouter: "bad" }] }, deps),
    ).rejects.toThrow("unknown API router");
    await expect(
      normalizeChatCreation("owner-id", { participants: [{ role: "user", userId: "other" }] }, deps),
    ).rejects.toThrow("cannot be supplied");
  });

  it("requires a resolvable named human", async () => {
    await expect(normalizeChatCreation("owner-id", { participants: [{ role: "user" }] }, deps)).rejects.toThrow(
      "username is required",
    );
    await expect(
      normalizeChatCreation("owner-id", { participants: [{ role: "user", name: "missing" }] }, deps),
    ).rejects.toThrow("no registered user");
  });

  it("strips unknown settings while rejecting unknown payload fields", () => {
    expect(createChatSchema.safeParse({ settings: { forceAiReply: true, future: false } }).success).toBe(true);
    expect(createChatSchema.safeParse({ extra: true }).success).toBe(false);
  });
});
