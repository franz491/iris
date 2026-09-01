import { beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { request as httpRequest, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-http-sse-disconnect-"));
  process.env.IRIS_BETTER_AUTH_SECRET = "test-secret-0123456789";
  vi.resetModules();
});

async function listen(
  fetch: (request: Request) => Response | Promise<Response>,
): Promise<{ server: Server; base: string }> {
  const server = serve({ fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening)
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function makeUser(): Promise<{ cookie: string }> {
  const { auth } = await import("../src/api/auth.js");
  await auth.api.signUpEmail({
    body: { email: "disconnect@iris.local", password: "password-123456", name: "disconnect" },
  });
  const response = await auth.api.signInEmail({
    body: { email: "disconnect@iris.local", password: "password-123456" },
    asResponse: true,
  });
  return {
    cookie: (response.headers.get("set-cookie") ?? "")
      .split(/,(?=[^;]+=)/)
      .map((v) => v.split(";")[0])
      .join("; "),
  };
}

async function openSse(
  base: string,
  chatId: string,
  cookie: string,
): Promise<{
  response: import("node:http").IncomingMessage;
  abort: () => void;
  data: () => string;
  waitFor: (text: string) => Promise<void>;
}> {
  const chunks: Buffer[] = [];
  let resolveWait: (() => void) | undefined;
  let expected = "";
  const req = httpRequest(`${base}/chats/${chatId}/stream?clientId=disconnect-test`, { headers: { cookie } });
  req.end();
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    req.once("response", resolve);
    req.once("error", reject);
  });
  response.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    if (expected && Buffer.concat(chunks).toString("utf8").includes(expected)) {
      expected = "";
      resolveWait?.();
      resolveWait = undefined;
    }
  });
  const waitFor = (text: string) => {
    if (Buffer.concat(chunks).toString("utf8").includes(text)) return Promise.resolve();
    expected = text;
    return new Promise<void>((resolve) => (resolveWait = resolve));
  };
  return { response, abort: () => req.destroy(), data: () => Buffer.concat(chunks).toString("utf8"), waitFor };
}

describe("real HTTP SSE disconnect cleanup", () => {
  it("removes only the aborted subscriber while a deferred generation continues for another", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { auth } = await import("../src/api/auth.js");
    const user = await makeUser();
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      {
        role: "user",
        name: "disconnect",
        userId: (await auth.api.getSession({ headers: { cookie: user.cookie } }))!.user.id,
      },
      { role: "ai", name: "bot", model: "m", apiRouter: "openai-compat" },
      { role: "ai", name: "bot-two", model: "m", apiRouter: "openai-compat" },
    ]);
    let release!: () => void;
    const deferred = new Promise<void>((resolve) => (release = resolve));
    const { registerApiRouter } = await import("../src/model-router/model-manager.js");
    registerApiRouter("openai-compat", {
      async *complete(request) {
        if (!request.stream) return;
        await deferred;
        yield { delta: "surviving subscriber" };
      },
      async completeOnce() {
        return { content: "" };
      },
    });
    const { api } = await import("../src/api/api.js");
    const bots = (await chat.getParticipants()).filter((participant) => participant.role === "ai");
    if (bots.length !== 2) throw new Error("missing bots");
    let server: Server;
    let base: string;
    try {
      ({ server, base } = await listen((request) => api.fetch(request)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const running = Promise.all(bots.map((bot) => chat.pingAiParticipant(bot as never))).then(() => undefined);
    const first = await openSse(base, chat.id, user.cookie);
    const second = await openSse(base, chat.id, user.cookie);
    await Promise.all([first.waitFor("connected"), second.waitFor("connected")]);
    first.abort();
    release();
    await running;
    await second.waitFor("surviving subscriber");
    expect(second.data()).toContain("surviving subscriber");
    expect(chat.replyingParticipants()).toEqual([]);
    second.abort();
    await new Promise((resolve) => server.close(resolve));
  });
});
