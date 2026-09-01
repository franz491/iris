// tests/memory.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-mem-"));
  vi.resetModules();
});

async function setup() {
  const dbm = await import("../src/chat/database.js");
  dbm.migrateChatDb();
  (await import("../src/memory/sql.js")).migrateMemoryDb();
  const { createChat } = await import("../src/chat/chat.js");
  return { createChat, memory: await import("../src/memory/memory.js") };
}

describe("memory", () => {
  it("public memories are visible in any chat", async () => {
    const { createChat, memory } = await setup();
    const chat = await createChat([
      { role: "user", name: "a", userId: "u1" },
      { role: "user", name: "b", userId: "u2" },
    ]);
    await memory.addMemory(chat.id, {
      type: "agent",
      keywords: ["prefs"],
      content: "likes concise answers",
      isPrivate: false,
    });
    const rows = await memory.listMemories(chat.id, "agent", ["prefs"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe("likes concise answers");
    const kw = await memory.listKeywords(chat.id, "agent");
    expect(kw).toEqual(["prefs"]);
  });

  it("private memories only visible to owner in single-user chats", async () => {
    const { createChat, memory } = await setup();
    // single-user chat
    const chat1 = await createChat([{ role: "user", name: "a", userId: "u1" }]);
    await memory.addMemory(chat1.id, {
      type: "self",
      keywords: ["secret"],
      content: "hidden note",
      isPrivate: true,
      ownerUserId: "u1",
    });
    const rows1 = await memory.listMemories(chat1.id, "self", ["secret"]);
    expect(rows1).toHaveLength(1);

    // multi-user chat: private hidden
    const chat2 = await createChat([
      { role: "user", name: "a", userId: "u1" },
      { role: "user", name: "b", userId: "u2" },
    ]);
    const rows2 = await memory.listMemories(chat2.id, "self", ["secret"]);
    expect(rows2).toHaveLength(0);

    // wrong owner cannot add private memory
    await expect(
      memory.addMemory(chat2.id, { type: "self", keywords: ["x"], content: "y", isPrivate: true, ownerUserId: "u3" }),
    ).rejects.toThrow();

    await memory.removeMemory(rows1[0].id);
    expect(await memory.listMemories(chat1.id, "self", ["secret"])).toHaveLength(0);
  });

  it("rejects invalid memory types", async () => {
    const { createChat, memory } = await setup();
    const chat = await createChat([{ role: "user", name: "a", userId: "u1" }]);
    await expect(
      memory.addMemory(chat.id, { type: "nope" as never, keywords: ["k"], content: "c", isPrivate: false }),
    ).rejects.toThrow(/invalid memory type/);
  });
});
