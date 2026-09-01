import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-attachment-"));
  process.env.IRIS_BETTER_AUTH_SECRET = "test-secret-attachment-012345";
  vi.resetModules();
});

describe("chat attachments", () => {
  it("uploads, creates a file message, and serves the correct image MIME type", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    await kernel.setConfig([
      {
        name: "files",
        activeFunctionalities: ["create_file", "read_file", "delete_file"],
        additionalSettings: { rootFolder: path.join(process.env.IRIS_DATA_DIR!, "files") },
      },
    ]);
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const { filesApi } = await import("../src/api/files.js");
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const upload = await filesApi.request(`/chats/${chat.id}/pasted%20image.png`, {
      method: "PUT",
      body: bytes,
    });
    expect(upload.status).toBe(201);
    expect(((await upload.json()) as { messageId?: string }).messageId).toBeTruthy();
    const messages = await chat.getMessagesSinceId("", "");
    expect(messages.some((m) => m.type === "file" && m.content === "[file] pasted image.png")).toBe(true);

    const download = await filesApi.request(`/chats/${chat.id}/pasted%20image.png`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);
  });

  it("rejects the upload before reading or staging after the account limit", async () => {
    const { migrateChatDb, listStagedAttachments } = await import("../src/chat/database.js");
    migrateChatDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    await kernel.setConfig([
      {
        name: "files",
        activeFunctionalities: ["create_file", "read_file", "delete_file"],
        additionalSettings: { rootFolder: path.join(process.env.IRIS_DATA_DIR!, "files") },
      },
    ]);
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const { UPLOAD_LIMIT_PER_WINDOW } = await import("../src/api/upload-limiter.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const { filesApi } = await import("../src/api/files.js");
    const body = Buffer.from("upload");
    for (let i = 0; i < UPLOAD_LIMIT_PER_WINDOW; i++) {
      const response = await filesApi.request(`/chats/${chat.id}/limited-${i}.bin`, { method: "PUT", body });
      expect(response.status).toBe(201);
    }
    const response = await filesApi.request(`/chats/${chat.id}/limited-rejected.bin`, {
      method: "PUT",
      body: "body must not be read",
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    expect(listStagedAttachments()).toHaveLength(0);
  });

  it("rejects paths outside the chat attachment namespace", async () => {
    const { filesApi } = await import("../src/api/files.js");
    const response = await filesApi.request("/arbitrary.txt", { method: "PUT", body: "x" });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects ambiguous, oversized, and traversal attachment paths before authorization work", async () => {
    const { filesApi } = await import("../src/api/files.js");
    const paths = [
      "/chats/chat-id/../secret.txt",
      "/chats/chat-id/%2e%2e/secret.txt",
      "/chats/chat-id/encoded%2Fseparator.txt",
      "/chats/chat-id/%00secret.txt",
      `/chats/chat-id/${"x".repeat(513)}.txt`,
      "/chats/chat-id/one/two.txt",
      "/chats/%2e%2e/file.txt",
      "/chats/chat-id/%5Cwindows.txt",
    ];
    for (const requestPath of paths) {
      const response = await filesApi.request(requestPath, { method: "PUT", body: "must not be read" });
      expect(response.status, requestPath).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }
  });

  it("rejects oversized attachment uploads before invoking the files provider", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const { MAX_ATTACHMENT_BYTES } = await import("../src/api/binary-limits.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const { filesApi } = await import("../src/api/files.js");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ATTACHMENT_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const response = await filesApi.request(`/chats/${chat.id}/too-large.bin`, {
      method: "PUT",
      body,
      duplex: "half",
    });
    expect(response.status).toBe(413);
    await expect(
      (await import("node:fs/promises")).readdir(path.join(process.env.IRIS_DATA_DIR!, "upload-tmp")),
    ).resolves.toEqual([]);
  });

  it("streams an exact-limit chunked upload and leaves no private temp file", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    await kernel.setConfig([
      {
        name: "files",
        activeFunctionalities: ["create_file", "read_file", "delete_file"],
        additionalSettings: { rootFolder: path.join(process.env.IRIS_DATA_DIR!, "files") },
      },
    ]);
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const { MAX_ATTACHMENT_BYTES } = await import("../src/api/binary-limits.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    let offset = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (offset === MAX_ATTACHMENT_BYTES) {
          controller.close();
          return;
        }
        const size = Math.min(64 * 1024, MAX_ATTACHMENT_BYTES - offset);
        controller.enqueue(new Uint8Array(size));
        offset += size;
      },
    });
    const { filesApi } = await import("../src/api/files.js");
    const response = await filesApi.request(`/chats/${chat.id}/exact.bin`, {
      method: "PUT",
      body,
      duplex: "half",
    });
    expect(response.status).toBe(201);
    expect(existsSync(path.join(process.env.IRIS_DATA_DIR!, "files", "chats", chat.id, "exact.bin"))).toBe(true);
    await expect(
      (await import("node:fs/promises")).readdir(path.join(process.env.IRIS_DATA_DIR!, "upload-tmp")),
    ).resolves.toEqual([]);
  });

  it("rejects invalid media before staging or provider writes", async () => {
    const { migrateChatDb, listStagedAttachments } = await import("../src/chat/database.js");
    migrateChatDb();
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const { filesApi } = await import("../src/api/files.js");
    const response = await filesApi.request(`/chats/${chat.id}/fake.png`, {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "image/png" },
    });
    expect(response.status).toBe(415);
    expect(listStagedAttachments()).toHaveLength(0);
  });

  it("removes the uploaded file when message persistence fails", async () => {
    const { migrateChatDb, listStagedAttachments } = await import("../src/chat/database.js");
    migrateChatDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    const root = path.join(process.env.IRIS_DATA_DIR!, "files");
    await kernel.setConfig([
      {
        name: "files",
        activeFunctionalities: ["create_file", "read_file", "delete_file"],
        additionalSettings: { rootFolder: root },
      },
    ]);
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    vi.spyOn(chat, "sendMessage").mockRejectedValueOnce(new Error("injected database failure"));
    const { filesApi } = await import("../src/api/files.js");
    const response = await filesApi.request(`/chats/${chat.id}/failed.bin`, {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(response.status).toBe(500);
    expect(existsSync(path.join(root, "chats", chat.id, "failed.bin"))).toBe(false);
    expect(listStagedAttachments(Date.now())).toHaveLength(0);
  });

  it("does not overwrite an existing attachment", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    const root = path.join(process.env.IRIS_DATA_DIR!, "files");
    await kernel.setConfig([
      {
        name: "files",
        activeFunctionalities: ["create_file", "read_file", "delete_file"],
        additionalSettings: { rootFolder: root },
      },
    ]);
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const existing = path.join(root, "chats", chat.id, "same.bin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(existing), { recursive: true });
    writeFileSync(existing, Buffer.from("original"));
    const { filesApi } = await import("../src/api/files.js");
    const response = await filesApi.request(`/chats/${chat.id}/same.bin`, {
      method: "PUT",
      body: Buffer.from("replacement"),
    });
    expect(response.status).toBe(409);
    expect(existsSync(existing)).toBe(true);
    await expect((await import("node:fs/promises")).readFile(existing, "utf8")).resolves.toBe("original");
  });

  it("serializes concurrent same-name uploads to one file and one message", async () => {
    const { migrateChatDb, listStagedAttachments } = await import("../src/chat/database.js");
    migrateChatDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    const root = path.join(process.env.IRIS_DATA_DIR!, "files");
    await kernel.setConfig([
      {
        name: "files",
        activeFunctionalities: ["create_file", "read_file", "delete_file"],
        additionalSettings: { rootFolder: root },
      },
    ]);
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const { filesApi } = await import("../src/api/files.js");
    const responses = await Promise.all([
      filesApi.request(`/chats/${chat.id}/race.bin`, { method: "PUT", body: Buffer.from("first") }),
      filesApi.request(`/chats/${chat.id}/race.bin`, { method: "PUT", body: Buffer.from("second") }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const messages = await chat.getMessagesSinceId("", "");
    expect(messages.filter((message) => message.type === "file" && message.content === "[file] race.bin")).toHaveLength(
      1,
    );
    expect(listStagedAttachments(Date.now())).toHaveLength(0);
  });

  it("rejects an oversized on-disk attachment while the provider is reading it", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    const root = path.join(process.env.IRIS_DATA_DIR!, "files");
    await kernel.setConfig([
      {
        name: "files",
        activeFunctionalities: ["create_file", "read_file", "delete_file"],
        additionalSettings: { rootFolder: root },
      },
    ]);
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const { MAX_ATTACHMENT_BYTES } = await import("../src/api/binary-limits.js");
    const file = path.join(root, "chats", chat.id, "huge.bin");
    const dir = path.dirname(file);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 7));
    const { filesApi } = await import("../src/api/files.js");
    const response = await filesApi.request(`/chats/${chat.id}/huge.bin`);
    expect(response.status).toBe(413);
  });

  it("reconciles crashed staged files, preserves committed files, retries deletion, and fails closed", async () => {
    const { migrateChatDb, stageAttachment, listStagedAttachments, clearAttachmentStage, chatSqlite } =
      await import("../src/chat/database.js");
    migrateChatDb();
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    const { kernel } = await import("../src/runtime/kernel.js");
    registerInstalledProviders();
    const root = path.join(process.env.IRIS_DATA_DIR!, "files");
    await kernel.setConfig([
      {
        name: "files",
        activeFunctionalities: ["create_file", "read_file", "delete_file"],
        additionalSettings: { rootFolder: root },
      },
    ]);
    const { createChat } = await import("../src/chat/chat.js");
    const { GUEST_USER_ID } = await import("../src/chat/auth.js");
    const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
    const { reconcileAttachmentStaging } = await import("../src/api/files.js");
    const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const crashed = `chats/${chat.id}/crashed.bin`;
    const crashedFile = path.join(root, crashed);
    mkdirSync(path.dirname(crashedFile), { recursive: true });
    writeFileSync(crashedFile, "orphan");
    stageAttachment({ id: "crashed-stage", chatId: chat.id, storagePath: crashed, createdAt: old });
    await reconcileAttachmentStaging();
    expect(existsSync(crashedFile)).toBe(false);
    expect(listStagedAttachments(Date.now())).toHaveLength(0);

    const committed = `chats/${chat.id}/committed.bin`;
    const committedFile = path.join(root, committed);
    writeFileSync(committedFile, "keep");
    stageAttachment({ id: "committed-stage", chatId: chat.id, storagePath: committed, createdAt: old });
    const participant = (await chat.getParticipants()).find((p) => p.role === "user")!;
    await chat.sendMessage({
      chatId: chat.id,
      authorId: participant.id,
      type: "file",
      thought: "",
      content: "[file] committed.bin",
    });
    await reconcileAttachmentStaging();
    expect(existsSync(committedFile)).toBe(true);
    expect(listStagedAttachments(Date.now())).toHaveLength(0);

    const retry = `chats/${chat.id}/retry.bin`;
    const retryFile = path.join(root, retry);
    writeFileSync(retryFile, "retry");
    stageAttachment({ id: "retry-stage", chatId: chat.id, storagePath: retry, createdAt: old });
    let attempts = 0;
    const originalUse = kernel.useProvider.bind(kernel);
    await reconcileAttachmentStaging(Date.now(), 0, async (...args) => {
      if (args[1] === "delete_file" && attempts++ === 0) throw new Error("temporary failure");
      return originalUse(...args);
    });
    expect(existsSync(retryFile)).toBe(true);
    expect(listStagedAttachments(Date.now())).toHaveLength(1);
    await reconcileAttachmentStaging(Date.now(), 0, originalUse);
    expect(existsSync(retryFile)).toBe(false);
    expect(listStagedAttachments(Date.now())).toHaveLength(0);

    const foreign = path.join(root, "chats", chat.id, "foreign.bin");
    writeFileSync(foreign, "safe");
    const malformed = path.join(root, "chats", chat.id, "malformed.bin");
    writeFileSync(malformed, "safe");
    chatSqlite
      .prepare("INSERT INTO attachment_staging(id, chat_id, storage_path, created_at) VALUES(?,?,?,?)")
      .run("bad record", chat.id, `chats/${chat.id}/malformed.bin`, -1);
    chatSqlite
      .prepare("INSERT INTO attachment_staging(id, chat_id, storage_path, created_at) VALUES(?,?,?,?)")
      .run("cross-chat", chat.id, "chats/another-chat/foreign.bin", old);
    await reconcileAttachmentStaging();
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(malformed)).toBe(true);
    clearAttachmentStage("missing");
  });

  it.each(["stage", "write", "rename", "message", "finalize", "compensate"] as const)(
    "keeps attachment resources recoverable at the %s fault boundary",
    async (fault) => {
      const { migrateChatDb, stageAttachment, clearAttachmentStage, listStagedAttachments, chatSqlite } =
        await import("../src/chat/database.js");
      migrateChatDb();
      const { createChat } = await import("../src/chat/chat.js");
      const { GUEST_USER_ID } = await import("../src/chat/auth.js");
      const chat = await createChat([{ role: "user", name: "guest", userId: GUEST_USER_ID }]);
      const { commitAttachment } = await import("../src/api/files.js");
      const root = process.env.IRIS_DATA_DIR!;
      const storagePath = `chats/${chat.id}/fault.bin`;
      const finalPath = path.join(root, storagePath);
      const tempPath = `${finalPath}.tmp`;
      const events: string[] = [];
      let compensationFailure = fault === "compensate";
      const stage = { id: "fault-stage", chatId: chat.id, storagePath, createdAt: Date.now() };
      const participant = (await chat.getParticipants()).find((p) => p.role === "user")!;
      const adapter = {
        stage: async (record: typeof stage) => {
          if (fault === "stage") throw new Error("stage fault");
          stageAttachment(record);
          events.push("staged");
        },
        write: async () => {
          mkdirSync(path.dirname(tempPath), { recursive: true });
          writeFileSync(tempPath, "payload");
          events.push("write");
          if (fault === "write") throw new Error("write fault");
          if (fault === "rename") throw new Error("rename fault");
          const { rename } = await import("node:fs/promises");
          await rename(tempPath, finalPath);
          events.push("renamed");
        },
        persistMessage: async () => {
          events.push("message");
          if (fault === "message" || fault === "compensate") throw new Error(`${fault} fault`);
          return chat.sendMessage({
            chatId: chat.id,
            authorId: participant.id,
            type: "file",
            thought: "",
            content: "[file] fault.bin",
          });
        },
        finalize: async (id: string) => {
          events.push("finalize");
          if (fault === "finalize") throw new Error("finalize fault");
          clearAttachmentStage(id);
        },
        compensate: async (_storage: string, id: string) => {
          events.push("compensate");
          if (compensationFailure) throw new Error("compensation fault");
          for (const candidate of [tempPath, finalPath]) {
            try {
              await (await import("node:fs/promises")).unlink(candidate);
            } catch {
              // The resource may not have been created yet.
            }
          }
          clearAttachmentStage(id);
        },
      };

      await expect(commitAttachment(stage, new Uint8Array([1]), adapter)).rejects.toThrow(`${fault} fault`);
      const messages = chatSqlite
        .prepare("SELECT content FROM messages WHERE chat_id=? AND content=?")
        .all(chat.id, "[file] fault.bin") as unknown[];
      expect(messages).toHaveLength(fault === "finalize" ? 1 : 0);
      expect(listStagedAttachments(Date.now())).toHaveLength(fault === "finalize" || fault === "compensate" ? 1 : 0);
      expect(existsSync(finalPath)).toBe(fault === "finalize" || fault === "compensate");
      expect(existsSync(tempPath)).toBe(false);
      if (fault === "stage") expect(events).toEqual([]);
      else if (fault !== "finalize") expect(events).toContain("compensate");

      // A retry of the durable recovery action is idempotent: no duplicate message is created.
      if (fault === "finalize") {
        clearAttachmentStage(stage.id);
        expect(listStagedAttachments(Date.now())).toHaveLength(0);
        expect(
          chatSqlite
            .prepare("SELECT 1 FROM messages WHERE chat_id=? AND content=?")
            .all(chat.id, "[file] fault.bin") as unknown[],
        ).toHaveLength(1);
      }
      if (fault === "compensate") {
        compensationFailure = false;
        await adapter.compensate(storagePath, stage.id);
        expect(existsSync(finalPath)).toBe(false);
        expect(existsSync(tempPath)).toBe(false);
        expect(listStagedAttachments(Date.now())).toHaveLength(0);
      }
    },
  );
});
