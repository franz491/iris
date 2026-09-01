// tests/memory-provider.test.ts — the always-on memory tool group executing
// through the kernel provider (chatId injected by the chat loop).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-memprov-"));
  vi.resetModules();
});

describe("memory provider", () => {
  it("stores and recalls memories with chatId injection", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { migrateMemoryDb } = await import("../src/memory/sql.js");
    migrateMemoryDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    await kernel.setConfig([
      {
        name: "memory",
        activeFunctionalities: ["list_keywords", "list_memories", "add_memory", "remove_memory"],
        additionalSettings: {},
      },
    ]);

    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "u", userId: "u1" },
      { role: "ai", name: "bot", model: "m" },
    ]);

    // through the same dispatch path the AI tool loop uses
    const { executeProviderTool } = await import("../src/chat/tools.js");
    const call = (fn: string, kwargs: Record<string, unknown>) =>
      executeProviderTool(
        {
          name: fn,
          arguments: JSON.stringify(kwargs),
          setting: { tool: "memory" },
          groupDef: {
            name: "memory",
            flavor: "provider",
            provider: "memory",
            functions: [{ name: fn, description: "", parameters: {}, functionality: fn }],
          },
          fnDef: { name: fn, description: "", parameters: {}, functionality: fn },
        },
        { chatId: chat.id },
      );

    const added = (await call("add_memory", {
      type: "self",
      keywords: ["coffee", "preferences"],
      content: "user drinks coffee black",
      isPrivate: false,
    })) as { ok: boolean; id: string };

    expect(added.ok).toBe(true);

    const kws = (await call("list_keywords", { type: "self" })) as { keywords: string[] };
    expect(kws.keywords).toContain("coffee");

    const found = (await call("list_memories", { type: "self", keywords: ["coffee"] })) as {
      memories: { id: string; keywords: string[]; content: string }[];
    };
    expect(found.memories).toHaveLength(1);
    expect(found.memories[0].keywords.sort()).toEqual(["coffee", "preferences"].sort());

    // removal by group id clears every keyword row
    await call("remove_memory", { id: added.id });
    const after = (await call("list_memories", { type: "self", keywords: ["preferences"] })) as {
      memories: unknown[];
    };
    expect(after.memories).toHaveLength(0);
  });

  it("rejects calls without a chatId (dispatch invariant)", async () => {
    const { migrateMemoryDb } = await import("../src/memory/sql.js");
    migrateMemoryDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    await kernel.setConfig([{ name: "memory", activeFunctionalities: ["add_memory"], additionalSettings: {} }]);
    const { executeProviderTool } = await import("../src/chat/tools.js");
    await expect(
      executeProviderTool(
        {
          name: "add_memory",
          arguments: "{}",
          setting: { tool: "memory" },
          groupDef: { name: "memory", flavor: "provider", provider: "memory", functions: [] },
          fnDef: { name: "add_memory", description: "", parameters: {}, functionality: "add_memory" },
        },
        { chatId: "" },
      ),
    ).rejects.toThrow(/chatId/);
  });
});
