// tests/api-integration.test.ts — supertest-style integration suite against
// the Hono app: auth gating, guest rules, edit/truncate permissions,
// tool-config push validation, whisper filtering over HTTP.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(async () => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-api-"));
  process.env.IRIS_BETTER_AUTH_SECRET = "test-secret-0123456789";
  vi.resetModules();
  const { migrateChatDb } = await import("../src/chat/database.js");
  migrateChatDb();
  await stubReplyRouter();
});

const PASSWORD = "password-123456";

interface TestUser {
  userId: string;
  cookie: string;
}

/** Register + sign in a user via better-auth; returns session cookie. */
async function makeUser(name: string): Promise<TestUser> {
  const { auth } = await import("../src/api/auth.js");
  await auth.api.signUpEmail({
    body: { email: `${name}@iris.local`, password: PASSWORD, name },
  });
  const res = await auth.api.signInEmail({
    body: { email: `${name}@iris.local`, password: PASSWORD },
    asResponse: true,
  });
  const cookie = (res.headers.get("set-cookie") ?? "")
    .split(/,(?=[^;]+=)/)
    .map((c) => c.split(";")[0])
    .join("; ");
  const { findUserByName } = await import("../src/api/auth.js");
  const user = findUserByName(name);
  if (!user) throw new Error(`user ${name} not found after signup`);
  return { userId: user.id, cookie };
}

function req(path: string, method: string, body?: unknown, cookie?: string): Promise<Response> {
  return import("../src/api/api.js").then(({ api }) =>
    api.request(path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function stubReplyRouter(): Promise<void> {
  const mm = await import("../src/model-router/model-manager.js");
  const fakeRouter: import("../src/model-router/types.js").ApiRouter = {
    async *complete(reqReq: import("../src/model-router/types.js").CompletionRequest) {
      if (!reqReq.stream) {
        yield { delta: '{"will_reply": true}', finishReason: "stop" };
        return;
      }
      yield { delta: "ok" };
    },
    async completeOnce() {
      return { content: '{"will_reply": true}' };
    },
  };
  // Chat fixtures default to llama.cpp unless a router is explicit. Register
  // both names so integration tests never fall through to native/network I/O.
  mm.registerApiRouter("openai-compat", fakeRouter);
  mm.registerApiRouter("llamacpp", fakeRouter);
}

describe("api integration", () => {
  it("validates participant additions and accepts bounded human and AI payloads", async () => {
    await stubReplyRouter();
    const alice = await makeUser("participant-owner");
    const bob = await makeUser("participant-member");
    const created = await req(
      "/chats",
      "POST",
      { participants: [{ role: "ai", name: "bot", model: "m", apiRouter: "openai-compat" }] },
      alice.cookie,
    );
    expect(created.status).toBe(201);
    const { chatId } = (await created.json()) as { chatId: string };

    const human = await req(
      `/chats/${chatId}/participants`,
      "POST",
      { role: "user", name: "participant-member" },
      alice.cookie,
    );
    expect(human.status).toBe(201);
    expect((await human.json()).userId).toBe(bob.userId);

    const ai = await req(
      `/chats/${chatId}/participants`,
      "POST",
      { role: "ai", name: "second bot", model: "m", apiRouter: "openai-compat", maxContext: 4096, prompt: "be brief" },
      alice.cookie,
    );
    expect(ai.status).toBe(201);

    for (const body of [
      undefined,
      { role: "other", name: "bad" },
      { role: "ai", name: ["bad"] },
      { role: "ai", name: "bad", maxContext: 0 },
      { role: "ai", name: "bad", unknown: true },
      { role: "ai", name: "x".repeat(257) },
    ]) {
      const response = await import("../src/api/api.js").then(({ api }) =>
        api.request(`/chats/${chatId}/participants`, {
          method: "POST",
          headers: {
            ...(alice.cookie ? { cookie: alice.cookie } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? "not-json" : JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  it("binds the creator and rejects human participant impersonation", async () => {
    await stubReplyRouter();
    const alice = await makeUser("identity-alice");
    const bob = await makeUser("identity-bob");

    let response = await req(
      "/chats",
      "POST",
      {
        participants: [
          { role: "user", userId: bob.userId, name: "identity-bob" },
          { role: "ai", name: "bot", model: "m", apiRouter: "openai-compat" },
        ],
      },
      alice.cookie,
    );
    expect(response.status).toBe(400);

    response = await req(
      "/chats",
      "POST",
      {
        participants: [
          { role: "user", name: "identity-bob" },
          { role: "ai", name: "bot", model: "m" },
        ],
      },
      alice.cookie,
    );
    expect(response.status).toBe(201);
    const { chatId } = (await response.json()) as { chatId: string };
    const { getParticipantsRows } = await import("../src/chat/database.js");
    const humans = (await getParticipantsRows(chatId)).filter((p) => p.role === "user");
    expect(humans.map((p) => p.userId)).toEqual(expect.arrayContaining([alice.userId, bob.userId]));
    expect(humans).toHaveLength(2);
  });

  it("includes the creator even when the payload supplies another human", async () => {
    await stubReplyRouter();
    const alice = await makeUser("identity-owner");
    const bob = await makeUser("identity-member");
    const response = await req(
      "/chats",
      "POST",
      {
        participants: [{ role: "user", name: "identity-member" }],
      },
      alice.cookie,
    );
    expect(response.status).toBe(201);
    const { chatId } = (await response.json()) as { chatId: string };
    const { isUserAuthorizedInChat } = await import("../src/chat/auth.js");
    expect(await isUserAuthorizedInChat(chatId, alice.userId)).toBe(true);
    expect(await isUserAuthorizedInChat(chatId, bob.userId)).toBe(true);
  });

  it("deduplicates the creator when repeated by userId and username", async () => {
    await stubReplyRouter();
    const alice = await makeUser("identity-duplicate");
    const response = await req(
      "/chats",
      "POST",
      {
        participants: [
          { role: "user", userId: alice.userId, name: "spoofed display name" },
          { role: "user", name: "identity-duplicate@iris.local" },
          { role: "ai", name: "bot", model: "m" },
        ],
      },
      alice.cookie,
    );
    expect(response.status).toBe(201);
    const { chatId } = (await response.json()) as { chatId: string };
    const { getParticipantsRows } = await import("../src/chat/database.js");
    const humans = (await getParticipantsRows(chatId)).filter((p) => p.role === "user");
    expect(humans).toHaveLength(1);
    expect(humans[0]?.userId).toBe(alice.userId);
    expect(humans[0]?.name).toBe("identity-duplicate");
  });

  it("rejects oversized declared JSON before route parsing", async () => {
    const { MAX_JSON_BODY_BYTES } = await import("../src/api/json-limits.js");
    const { api } = await import("../src/api/api.js");
    const response = await api.request("/chats", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_JSON_BODY_BYTES + 1),
      },
      body: "{}",
    });
    expect(response.status).toBe(413);

    const { adminApi } = await import("../src/api/admin.js");
    const adminResponse = await adminApi.request("/bootstrap/create-admin", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_JSON_BODY_BYTES + 1),
      },
      body: "{}",
    });
    expect(adminResponse.status).toBe(413);
  });

  it("throttles repeated authenticated service probes", async () => {
    const { serviceProbeLimiter, SERVICE_PROBE_LIMIT_PER_WINDOW } = await import("../src/api/service-probe-limiter.js");
    serviceProbeLimiter.reset();
    const admin = await makeUser("probe-admin");
    (await import("../src/api/auth.js")).setAdminRole(admin.userId, "admin");
    for (let i = 0; i < SERVICE_PROBE_LIMIT_PER_WINDOW; i++) {
      expect(
        (
          await (
            await import("../src/api/admin.js")
          ).adminApi.request("/services", { headers: { cookie: admin.cookie } })
        ).status,
      ).not.toBe(429);
    }
    const limited = await (
      await import("../src/api/admin.js")
    ).adminApi.request("/services", {
      headers: { cookie: admin.cookie },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("returns a bounded timeout for a slow chunked JSON body in both routers", async () => {
    process.env.IRIS_JSON_BODY_TIMEOUT_MS = "20";
    vi.resetModules();
    const slowBody = () =>
      new ReadableStream({
        start() {
          // Deliberately never produce or close a chunk.
        },
      });
    const { api } = await import("../src/api/api.js");
    const { adminApi } = await import("../src/api/admin.js");
    const init = () =>
      ({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: slowBody(),
        duplex: "half",
      }) as RequestInit;
    await expect(api.request("/chats", init())).resolves.toMatchObject({ status: 408 });
    await expect(adminApi.request("/bootstrap/create-admin", init())).resolves.toMatchObject({ status: 408 });
  });

  it("guests cannot create chats, manage cards, or access registered-user chats", async () => {
    await stubReplyRouter();
    // guest blocked from chat creation
    let res = await req("/chats", "POST", { participants: [] });
    expect(res.status).toBe(401);

    // guest blocked from ai-cards management
    for (const [method, path, body] of [
      ["GET", "/ai-cards", undefined],
      ["POST", "/ai-cards", { name: "x", model: "m" }],
    ] as const) {
      res = await req(path, method, body);
      expect(res.status).toBe(401);
    }

    // registered user creates a chat -> guest cannot touch it
    const alice = await makeUser("alice");
    res = await req(
      "/chats",
      "POST",
      { participants: [{ role: "ai", name: "bot", model: "m", apiRouter: "openai-compat" }] },
      alice.cookie,
    );
    expect(res.status).toBe(201);
    const { chatId } = (await res.json()) as { chatId: string };

    for (const [method, path, body] of [
      ["GET", `/polling/messages?chatId=${chatId}&lastMessageId=`, undefined],
      ["GET", `/chats/${chatId}/history`, undefined],
      ["POST", `/chats/${chatId}/messages`, { content: "hi" }],
      ["PATCH", `/chats/${chatId}`, { name: "renamed" }],
      ["DELETE", `/chats/${chatId}/context`, undefined],
      ["PATCH", `/chats/${chatId}/tool-config`, { tools: [] }],
    ] as const) {
      res = await req(path, method, body);
      expect(res.status).toBe(401);
    }
  });

  it("rate-limits guest message attempts before chat lookup and ignores spoofed source headers", async () => {
    const { guestChatLimiter, GUEST_CHAT_MESSAGE_LIMIT_PER_WINDOW } = await import("../src/api/guest-chat-limiter.js");
    guestChatLimiter.reset();
    const { api } = await import("../src/api/api.js");
    for (let i = 0; i < GUEST_CHAT_MESSAGE_LIMIT_PER_WINDOW; i++) {
      const response = await api.request(`/chats/missing-${i}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-iris-remote-address": `spoof-${i}` },
        body: JSON.stringify({ content: "hello" }),
      });
      expect(response.status).not.toBe(429);
    }
    const limited = await api.request("/chats/still-missing/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-iris-remote-address": "another-spoof" },
      body: JSON.stringify({ content: "hello" }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
  });

  it("rate-limits guest chat access and creation attempts", async () => {
    const { guestChatLimiter, GUEST_CHAT_ACCESS_LIMIT_PER_WINDOW } = await import("../src/api/guest-chat-limiter.js");
    guestChatLimiter.reset();
    const { api } = await import("../src/api/api.js");
    for (let i = 0; i < GUEST_CHAT_ACCESS_LIMIT_PER_WINDOW; i++) {
      const response = await api.request("/chats/guest", {
        headers: { "x-iris-remote-address": `spoof-${i}` },
      });
      expect(response.status).not.toBe(429);
    }
    const limited = await api.request("/chats/guest", {
      headers: { "x-iris-remote-address": "another-spoof" },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });

  it("rejects unsafe SSE client query values before subscriber registration", async () => {
    const { api } = await import("../src/api/api.js");
    for (const query of ["clientId=" + "x".repeat(257), "clientId=one&clientId=two", "unexpected=value"]) {
      const response = await api.request(`/chats/missing/stream?${query}`);
      expect(response.status).toBe(400);
    }
  });

  it("non-members are rejected on chat-scoped routes", async () => {
    await stubReplyRouter();
    const alice = await makeUser("alice");
    const mallory = await makeUser("mallory");
    let res = await req("/chats", "POST", { participants: [{ role: "ai", name: "bot", model: "m" }] }, alice.cookie);
    const { chatId } = (await res.json()) as { chatId: string };
    res = await req(`/chats/${chatId}/messages`, "POST", { content: "secret" }, alice.cookie);
    expect(res.status).toBe(201);

    for (const [method, path, body] of [
      ["GET", `/polling/messages?chatId=${chatId}&lastMessageId=`, undefined],
      ["GET", `/chats/${chatId}/history`, undefined],
      ["GET", `/chats/${chatId}/participants`, undefined],
      ["POST", `/chats/${chatId}/messages`, { content: "intrude" }],
      ["PATCH", `/chats/${chatId}`, { name: "mine now" }],
      ["DELETE", `/chats/${chatId}`, undefined],
    ] as const) {
      res = await req(path, method, body, mallory.cookie);
      expect(res.status).toBe(401);
    }
  });

  it("enforces registered, chat-member, and admin route policies", async () => {
    await stubReplyRouter();
    const alice = await makeUser("policy-alice");
    const member = await makeUser("policy-member");
    const outsider = await makeUser("policy-outsider");
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "alice", userId: alice.userId },
      { role: "user", name: "member", userId: member.userId },
      { role: "ai", name: "bot", model: "m" },
    ]);

    // A signed-in non-member cannot use the attachment API merely by guessing
    // its chat-scoped path.
    const { filesApi } = await import("../src/api/files.js");
    const fileResponse = await filesApi.request(`/chats/${chat.id}/private.txt`, {
      headers: { cookie: outsider.cookie },
    });
    expect(fileResponse.status).toBe(401);

    const { adminApi } = await import("../src/api/admin.js");
    for (const cookie of [undefined, outsider.cookie]) {
      const response = await adminApi.request("/status", { headers: cookie ? { cookie } : {} });
      expect(response.status).toBe(403);
    }

    // An explicit role grant, not simple authentication, is required.
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(alice.userId, "admin");
    const adminResponse = await adminApi.request("/status", { headers: { cookie: alice.cookie } });
    expect(adminResponse.status).toBe(200);
  });

  it("protects support bundle export and returns redacted attachment JSON", async () => {
    const { adminApi } = await import("../src/api/admin.js");
    expect((await adminApi.request("/support-bundle")).status).toBe(403);
    const admin = await makeUser("bundle-admin");
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(admin.userId, "admin");
    const response = await adminApi.request("/support-bundle", { headers: { cookie: admin.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("iris-support-bundle.json");
    const body = await response.text();
    expect(body).not.toMatch(/apiKey|password|token|cookie|\/private/);
  });

  it("strictly validates audio metadata family queries", async () => {
    const admin = await makeUser("audio-metadata-admin");
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(admin.userId, "admin");
    const { adminApi } = await import("../src/api/admin.js");
    const headers = { cookie: admin.cookie };

    expect((await adminApi.request("/audio/metadata", { headers })).status).toBe(200);
    for (const query of [
      "?family=",
      "?family=pocket_tts&family=pocket_tts",
      `?family=${"x".repeat(129)}`,
      "?family=pocket_tts&unexpected=x",
    ]) {
      const response = await adminApi.request(`/audio/metadata${query}`, { headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }
  });

  it("strictly validates ComfyUI output query values before service work", async () => {
    const admin = await makeUser("comfy-output-query-admin");
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(admin.userId, "admin");
    const { adminApi } = await import("../src/api/admin.js");
    const headers = { cookie: admin.cookie };
    for (const query of [
      "?filename=",
      "?filename=image.png&filename=other.png",
      `?filename=${"x".repeat(513)}`,
      "?filename=image.png&unknown=x",
      "?filename=image.png&type=invalid",
    ]) {
      const response = await adminApi.request(`/services/missing/comfyui/output${query}`, { headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }
  });

  it("strictly validates STT filenames before service lookup and body read", async () => {
    const admin = await makeUser("stt-filename-admin");
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(admin.userId, "admin");
    const { adminApi } = await import("../src/api/admin.js");
    for (const filename of ["", " ", "x".repeat(256)]) {
      const response = await adminApi.request("/services/missing/stt/transcribe", {
        method: "POST",
        headers: { cookie: admin.cookie, origin: "http://localhost:5173", "x-filename": filename },
        body: new Uint8Array([1, 2, 3]),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }
  });

  it("strictly validates ComfyUI workflow and prompt identifiers before work", async () => {
    const admin = await makeUser("comfy-identifier-admin");
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(admin.userId, "admin");
    const { adminApi } = await import("../src/api/admin.js");
    const headers = { cookie: admin.cookie, origin: "http://localhost:5173" };
    for (const id of ["%00", "%20", "x".repeat(257)]) {
      const response = await adminApi.request(`/comfyui/workflows/${id}`, { method: "DELETE", headers });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }
    const prompt = await adminApi.request("/services/missing/comfyui/prompt", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ workflow: {}, clientId: "ok" }),
    });
    expect(prompt.status).toBe(404);
    const invalidPrompt = await adminApi.request("/services/%00/comfyui/prompt", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ workflow: {}, clientId: "ok" }),
    });
    expect(invalidPrompt.status).toBe(400);
    for (const suffix of ["queue", "stats", "output?filename=image.png"]) {
      const invalidService = await adminApi.request(`/services/${encodeURIComponent("bad/name")}/comfyui/${suffix}`, {
        method: "GET",
        headers,
      });
      expect(invalidService.status, suffix).toBe(400);
      expect(await invalidService.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }
    const invalidName = await adminApi.request("/services/missing/comfyui/prompt", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "bad\u0000name", workflow: {} }),
    });
    expect(invalidName.status).toBe(400);
  });

  it("strictly validates admin user and patch route identifiers", async () => {
    const admin = await makeUser("admin-route-id-admin");
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(admin.userId, "admin");
    const { adminApi } = await import("../src/api/admin.js");
    const headers = { cookie: admin.cookie, origin: "http://localhost:5173" };
    for (const route of [
      "/users/%00/sessions",
      `/users/${"x".repeat(257)}/sessions`,
      "/patches/%00",
      `/patches/${"x".repeat(257)}/validate`,
    ]) {
      const response = await adminApi.request(route, {
        method: route.endsWith("validate") ? "POST" : "GET",
        headers,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }
  });

  it("strictly validates remaining admin route identifiers before work", async () => {
    const admin = await makeUser("admin-remaining-id-admin");
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(admin.userId, "admin");
    const { adminApi } = await import("../src/api/admin.js");
    const headers = { cookie: admin.cookie, origin: "http://localhost:5173" };
    const cases = [
      ["GET", "/setup/sections/%00"],
      ["GET", `/setup/options/${"x".repeat(257)}`],
      ["GET", "/prompts/%00"],
      ["DELETE", `/keys/${"x".repeat(257)}`],
      ["DELETE", "/models/%00"],
      ["POST", "/services/%00/start"],
      ["POST", `/services/${"x".repeat(257)}/stop`],
      ["POST", "/services/%00/stt/transcribe"],
      ["POST", "/checklist/%00"],
    ] as const;
    for (const [method, route] of cases) {
      const response = await adminApi.request(route, {
        method,
        headers: { ...headers, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" && route.includes("checklist") ? { body: JSON.stringify({ state: "verified" }) } : {}),
      });
      expect(response.status, `${method} ${route}`).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }
  });

  it("rejects support bundle export from an authenticated stale session", async () => {
    const { adminApi } = await import("../src/api/admin.js");
    const admin = await makeUser("bundle-stale-admin");
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(admin.userId, "admin");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    try {
      const response = await adminApi.request("/support-bundle", { headers: { cookie: admin.cookie } });
      expect(response.status).toBe(403);
    } finally {
      vi.useRealTimers();
    }
  });

  it("covers positive and negative chat, polling, tool, and admin route policy cases", async () => {
    const member = await makeUser("route-policy-member");
    const outsider = await makeUser("route-policy-outsider");
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(member.userId, "admin");
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "route-policy-member", userId: member.userId },
      { role: "ai", name: "route-policy-bot", model: "m" },
    ]);
    const { api } = await import("../src/api/api.js");
    const { adminApi } = await import("../src/api/admin.js");

    type Actor = "guest" | "outsider" | "member" | "admin";
    const cookies: Record<Actor, string | undefined> = {
      guest: undefined,
      outsider: outsider.cookie,
      member: member.cookie,
      admin: member.cookie,
    };
    const request = async (target: typeof api, method: string, route: string, actor: Actor, body?: unknown) =>
      target.request(route, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookies[actor] ? { cookie: cookies[actor] } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const chatRoutes = [
      ["GET", `/chats/${chat.id}/history`, undefined],
      ["GET", `/polling/messages?chatId=${chat.id}&lastMessageId=`, undefined],
      ["GET", `/chats/${chat.id}/participants`, undefined],
      ["GET", `/chats/${chat.id}/compaction`, undefined],
      ["GET", `/tools?chatId=${chat.id}`, undefined],
      ["PATCH", `/chats/${chat.id}/tool-config`, { clientId: "route-policy", tools: [] }],
    ] as const;
    for (const [method, route, body] of chatRoutes) {
      for (const [actor, expected] of [
        ["guest", 401],
        ["outsider", 401],
        ["member", 200],
        ["admin", 200],
      ] as const) {
        const response = await request(api, method, route, actor, body);
        expect(response.status, `${method} ${route} as ${actor}`).toBe(expected);
      }
    }

    const sharedRoutes = [
      ["GET", "/polling/chats?timestamp=0"],
      ["GET", "/model-routers"],
      ["GET", "/setup-info"],
    ] as const;
    for (const [method, route] of sharedRoutes) {
      for (const actor of ["guest", "outsider", "member", "admin"] as const) {
        const response = await request(api, method, route, actor);
        expect(response.status, `${method} ${route} as ${actor}`).toBe(200);
      }
    }

    const adminRoutes = [
      ["GET", "/status"],
      ["GET", "/prompts"],
      ["GET", "/keys"],
      ["GET", "/services/defaults"],
      ["GET", "/comfyui/workflows"],
      ["GET", "/models"],
      ["GET", "/audit"],
    ] as const;
    for (const [method, route] of adminRoutes) {
      for (const [actor, expected] of [
        ["guest", 403],
        ["outsider", 403],
        ["member", 200],
        ["admin", 200],
      ] as const) {
        const response = await request(adminApi, method, route, actor);
        expect(response.status, `${method} /api/admin${route} as ${actor}`).toBe(expected);
      }
    }
  });

  it("keeps every non-bootstrap admin endpoint admin-only", async () => {
    const outsider = await makeUser("policy-admin-outsider");
    const { adminApi } = await import("../src/api/admin.js");

    // Keep this table aligned with the admin route declarations. Every route
    // below must call requireAdmin (directly or through actor) before parsing
    // input or touching state. Bootstrap routes are intentionally excluded:
    // they have their own unconfigured-server policy.
    const protectedRoutes = [
      ["GET", "/users"],
      ["POST", "/users"],
      ["POST", "/users/user-id/role"],
      ["POST", "/users/user-id/password"],
      ["DELETE", "/users/user-id"],
      ["GET", "/users/user-id/sessions"],
      ["DELETE", "/users/user-id/sessions"],
      ["GET", "/status"],
      ["GET", "/prompts"],
      ["GET", "/setup/sections"],
      ["POST", "/setup/chat"],
      ["GET", "/setup/sections/server"],
      ["GET", "/setup/options/server"],
      ["GET", "/prompts/example"],
      ["PUT", "/prompts/example"],
      ["DELETE", "/prompts/example"],
      ["POST", "/setup/proposals"],
      ["POST", "/checklist/foundation"],
      ["GET", "/audit"],
      ["GET", "/keys"],
      ["PUT", "/keys/example"],
      ["DELETE", "/keys/example"],
      ["GET", "/services/defaults"],
      ["GET", "/software"],
      ["GET", "/audio/metadata"],
      ["POST", "/software/audio.cpp/install"],
      ["POST", "/software/llama.cpp/install"],
      ["POST", "/software/comfyui/install"],
      ["GET", "/services"],
      ["GET", "/comfyui/workflows"],
      ["PUT", "/comfyui/workflows/workflow-id"],
      ["POST", "/comfyui/workflows"],
      ["DELETE", "/comfyui/workflows/workflow-id"],
      ["POST", "/services/comfy/comfyui/prompt"],
      ["GET", "/services/comfy/comfyui/history/prompt-id"],
      ["GET", "/services/comfy/comfyui/queue"],
      ["GET", "/services/comfy/comfyui/stats"],
      ["GET", "/services/comfy/comfyui/output?filename=output.png"],
      ["POST", "/services/audio/stt/transcribe"],
      ["GET", "/discovery"],
      ["GET", "/models"],
      ["POST", "/models"],
      ["DELETE", "/models/model-id"],
      ["POST", "/services/example/start"],
      ["POST", "/services/example/stop"],
      ["POST", "/patches"],
      ["POST", "/patches/patch-id/validate"],
      ["POST", "/patches/patch-id/test"],
      ["POST", "/patches/patch-id/approve"],
      ["POST", "/patches/patch-id/apply"],
      ["POST", "/patches/patch-id/rollback"],
      ["POST", "/reset-defaults"],
      ["GET", "/patches/patch-id"],
    ] as const;

    for (const [method, path] of protectedRoutes) {
      for (const cookie of [undefined, outsider.cookie]) {
        const response = await adminApi.request(path, {
          method,
          headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
          body: method === "GET" || method === "DELETE" ? undefined : "{}",
        });
        // A few legacy mutation handlers intentionally normalize every caught
        // error to 400; both statuses are non-authorized responses here.
        expect([400, 403], `${method} ${path} (${cookie ? "user" : "guest"})`).toContain(response.status);
      }
    }
  });

  it("normalizes mutation authorization and rejects cookie mutations without a trusted origin", async () => {
    const outsider = await makeUser("admin-csrf-outsider");
    const { adminApi } = await import("../src/api/admin.js");

    const denied = await adminApi.request("/keys/example", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: outsider.cookie },
      body: JSON.stringify({ value: "must-not-write" }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "csrf_origin_required" });

    const unauthorized = await adminApi.request("/keys/example", {
      method: "PUT",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ value: "must-not-write" }),
    });
    expect(unauthorized.status).toBe(403);
    expect(await unauthorized.json()).toEqual({ error: "forbidden" });
  });

  it("rejects malformed high-impact admin mutation payloads at the route boundary", async () => {
    const admin = await makeUser("admin-payload-boundary");
    const { setAdminRole } = await import("../src/api/auth.js");
    setAdminRole(admin.userId, "admin");
    const { adminApi } = await import("../src/api/admin.js");
    const headers = {
      "content-type": "application/json",
      cookie: admin.cookie,
      origin: "http://localhost:5173",
    };

    const cases = [
      ["POST", "/setup/proposals", "invalid_proposal"],
      ["PUT", "/comfyui/workflows/workflow-id", "invalid_workflow"],
      ["POST", "/comfyui/workflows", "invalid_workflow"],
      ["POST", "/services/ComfyUI/comfyui/prompt", "comfyui_request_failed"],
      ["POST", "/models", "invalid_model"],
      ["POST", "/patches", "invalid_patch"],
      ["POST", "/patches/patch-id/approve", "approval_failed"],
    ] as const;

    for (const [method, path, error] of cases) {
      const response = await adminApi.request(path, {
        method,
        headers,
        body: JSON.stringify({}),
      });
      expect(response.status, `${method} ${path}`).toBe(400);
      expect((await response.json()).error, `${method} ${path}`).toBe(error);
    }

    expect((await adminApi.request("/comfyui/workflows", { headers })).status).toBe(200);
    expect((await adminApi.request("/models", { headers })).status).toBe(200);
  });

  it("editing rewrites the branch in backend history", async () => {
    await stubReplyRouter();
    const alice = await makeUser("alice");
    let res = await req("/chats", "POST", { participants: [{ role: "ai", name: "bot", model: "m" }] }, alice.cookie);
    const { chatId } = (await res.json()) as { chatId: string };

    // two messages
    const ids: string[] = [];
    for (const text of ["first", "second"]) {
      res = await req(`/chats/${chatId}/messages`, "POST", { content: text }, alice.cookie);
      expect(res.status).toBe(201);
      ids.push(((await res.json()) as { messageId: string }).messageId);
    }

    // edit the first
    res = await req(`/chats/${chatId}/messages/${ids[0]}`, "PATCH", { content: "FIRST (edited)" }, alice.cookie);
    expect(res.status).toBe(200);
    const edited = (await res.json()) as { message: { id: string; content: string }; deletedFollowing: number };
    expect(edited.message.id).toBe(ids[0]);
    expect(edited.message.content).toBe("FIRST (edited)");
    expect(edited.deletedFollowing).toBeGreaterThanOrEqual(1);

    res = await req(`/chats/${chatId}/history`, "GET", undefined, alice.cookie);
    const page = (await res.json()) as { messages: { id: string; content: string }[] };
    expect(page.messages.some((m) => m.content === "second")).toBe(false);
    expect(page.messages.some((m) => m.content === "FIRST (edited)")).toBe(true);
  });

  it("returns 400 for malformed or invalid message payloads", async () => {
    const alice = await makeUser("message-validation-alice");
    const created = await req(
      "/chats",
      "POST",
      { participants: [{ role: "ai", name: "bot", model: "m" }] },
      alice.cookie,
    );
    const { chatId } = (await created.json()) as { chatId: string };

    const invalidPayloads: unknown[] = [
      { content: 42 },
      { content: "hello", to: ["participant", 7] },
      { content: "hello", to: ["x".repeat(257)] },
      { content: "" },
    ];
    for (const payload of invalidPayloads) {
      const response = await req(`/chats/${chatId}/messages`, "POST", payload, alice.cookie);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }

    const { api } = await import("../src/api/api.js");
    const malformed = await api.request(`/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: alice.cookie },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
  });

  it("tool-config push accepts known groups and reports active counts", async () => {
    await stubReplyRouter();
    const alice = await makeUser("alice");
    let res = await req("/chats", "POST", { participants: [{ role: "ai", name: "bot", model: "m" }] }, alice.cookie);
    const { chatId } = (await res.json()) as { chatId: string };

    // push an overlay with a frontend group + approval flag
    res = await req(
      `/chats/${chatId}/tool-config`,
      "PATCH",
      { clientId: "desktop-1", tools: [{ tool: "fe_files", requiresApproval: true }], loadedTools: ["backend_shell"] },
      alice.cookie,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { active: number; loaded: string[] };
    expect(data.active).toBeGreaterThan(0);
    // always-loaded groups stay implicit; unknown groups are dropped silently
    expect(data.loaded).toContain("read_tool_info");

    // garbage payload is not accepted as valid group names
    res = await req(
      `/chats/${chatId}/tool-config`,
      "PATCH",
      { clientId: "desktop-1", loadedTools: ["nope"], tools: [] },
      alice.cookie,
    );
    expect(res.status).toBe(200);
    const data2 = (await res.json()) as { loaded: string[] };
    expect(data2.loaded).not.toContain("nope");

    // non-member cannot push config
    const mallory = await makeUser("mallory");
    res = await req(`/chats/${chatId}/tool-config`, "PATCH", { clientId: "mallory-phone", tools: [] }, mallory.cookie);
    expect(res.status).toBe(401);
  });

  it("rejects malformed chat-scoped mutation payloads at the API boundary", async () => {
    await stubReplyRouter();
    const alice = await makeUser("schema-alice");
    const created = await req(
      "/chats",
      "POST",
      { participants: [{ role: "ai", name: "bot", model: "m" }] },
      alice.cookie,
    );
    const { chatId } = (await created.json()) as { chatId: string };

    const cases: Array<[string, string, unknown]> = [
      [
        "PATCH",
        `/chats/${chatId}/tool-config`,
        { clientId: "desktop", tools: [{ tool: "shell", approvalTimeoutMs: -1 }] },
      ],
      ["POST", `/chats/${chatId}/tool-response`, { requestId: "request", clientId: "desktop", approved: "yes" }],
      ["PATCH", `/chats/${chatId}/messages/missing`, { content: "ok", unexpected: true }],
      ["PATCH", `/chats/${chatId}`, { name: "   " }],
    ];
    for (const [method, path, body] of cases) {
      const response = await req(path, method, body, alice.cookie);
      expect(response.status, `${method} ${path}`).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }

    const { api } = await import("../src/api/api.js");
    const malformedStop = await api.request(`/chats/${chatId}/stop`, {
      method: "POST",
      headers: { cookie: alice.cookie, "content-type": "application/json" },
      body: "not-json",
    });
    expect(malformedStop.status).toBe(400);
    expect(await malformedStop.json()).toEqual(expect.objectContaining({ error: "validation_error" }));

    const oversizedStop = await req(`/chats/${chatId}/stop`, "POST", { participantId: "x".repeat(257) }, alice.cookie);
    expect(oversizedStop.status).toBe(400);
  });

  it("rejects invalid pagination and polling cursors", async () => {
    const alice = await makeUser("query-alice");
    const created = await req(
      "/chats",
      "POST",
      { participants: [{ role: "ai", name: "bot", model: "m" }] },
      alice.cookie,
    );
    const { chatId } = (await created.json()) as { chatId: string };

    for (const path of [
      `/chats/${chatId}/history?limit=0`,
      `/chats/${chatId}/history?limit=not-a-number`,
      `/chats/${chatId}/history?before=-1`,
      "/polling/chats?timestamp=-1",
      "/polling/chats?timestamp=NaN",
      "/polling/messages?chatId=&lastMessageId=",
      `/polling/messages?chatId=${chatId}&lastMessageId=${"x".repeat(257)}`,
      `/audio-cache/cache-id?chatId=${chatId}&chatId=${chatId}`,
      `/audio-cache/cache-id?chatId=`,
      `/chats/${chatId}/history?limit=50&limit=50`,
      `/chats/${chatId}/history?limit=50&unknown=1`,
      `/polling/messages?chatId=${chatId}&lastMessageId=&lastMessageId=other`,
      `/polling/messages?chatId=${chatId}&unknown=1`,
      "/polling/chats?timestamp=0&timestamp=1",
      "/polling/chats?timestamp=0&unknown=1",
    ]) {
      const response = await req(path, "GET", undefined, alice.cookie);
      expect(response.status, path).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }
  });

  it("rejects decoded oversized and control-character chat route IDs before state work", async () => {
    const alice = await makeUser("route-id-alice");
    const cases = [
      [`/chats/${encodeURIComponent("x".repeat(257))}/history`, "GET"],
      [`/chats/${encodeURIComponent("bad\u0000id")}/messages`, "POST"],
      [`/chats/${encodeURIComponent("x".repeat(257))}/participants/${encodeURIComponent("participant")}`, "PATCH"],
    ] as const;
    for (const [route, method] of cases) {
      const response = await req(
        route,
        method,
        method === "PATCH" ? { readsOthersThoughts: true } : undefined,
        alice.cookie,
      );
      expect(response.status, `${method} ${route}`).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({ error: "validation_error" }));
    }
  });

  it("strictly bounds tools and model-router query parameters", async () => {
    const alice = await makeUser("strict-query-alice");
    const modelManager = await import("../src/model-router/model-manager.js");
    const listModels = vi.spyOn(modelManager, "listModels").mockResolvedValue([]);
    try {
      // chatId remains optional; an explicit empty value preserves the legacy
      // catalog-only request while all other keys are rejected at the boundary.
      expect((await req("/tools?chatId=", "GET")).status).toBe(200);
      for (const route of [
        `/tools?chatId=${"x".repeat(257)}`,
        "/tools?chatId=one&chatId=two",
        "/tools?chatId=valid&unexpected=1",
      ]) {
        expect((await req(route, "GET")).status, route).toBe(400);
      }

      expect((await req("/models?router=%20llamacpp%20", "GET", undefined, alice.cookie)).status).toBe(200);
      expect(listModels).toHaveBeenCalledWith("llamacpp");
      listModels.mockClear();
      expect((await req("/models", "GET", undefined, alice.cookie)).status).toBe(200);
      expect(listModels).toHaveBeenCalledWith("llamacpp");
      for (const route of [
        `/models?router=${"x".repeat(257)}`,
        "/models?router=llamacpp&router=openai-compat",
        "/models?router=",
        "/models?router=not-registered",
        "/models?router=llamacpp&unexpected=1",
      ]) {
        expect((await req(route, "GET", undefined, alice.cookie)).status, route).toBe(400);
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not expose tool configuration or generic provider execution outside an authorized chat", async () => {
    await stubReplyRouter();
    const alice = await makeUser("tools-alice");
    const mallory = await makeUser("tools-mallory");
    const created = await req(
      "/chats",
      "POST",
      { participants: [{ role: "ai", name: "bot", model: "m" }] },
      alice.cookie,
    );
    const { chatId } = (await created.json()) as { chatId: string };

    let response = await req(`/tools?chatId=${chatId}`, "GET", undefined, mallory.cookie);
    expect(response.status).toBe(401);

    response = await req("/providers/files/read_file", "POST", { filename: "anything" }, alice.cookie);
    expect(response.status).toBe(404);

    response = await req("/stream/audio/default", "POST", new Uint8Array([1, 2, 3]), alice.cookie);
    expect(response.status).toBe(404);
  });

  it("whisper readability is enforced over HTTP history reads", async () => {
    await stubReplyRouter();
    const { createChat } = await import("../src/chat/chat.js");
    const alice = await makeUser("alice2");
    const bob = await makeUser("bob2");
    const chat = await createChat([
      { role: "user", name: "alice", userId: alice.userId },
      { role: "user", name: "bob", userId: bob.userId },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const parts = await chat.getParticipants();
    const aliceP = parts.find((p) => p.name === "alice")!;
    const bot = parts.find((p) => p.name === "bot")!;
    const { insertMessage } = await import("../src/chat/database.js");
    // AI whispers to alice: bob must NOT see it over HTTP
    await insertMessage({
      chatId: chat.id,
      authorId: bot.id,
      type: "text",
      thought: "",
      content: "psst alice",
      to: [aliceP.id],
    });
    // AI->AI style broadcast check: normal broadcast visible to everyone
    await insertMessage({ chatId: chat.id, authorId: bot.id, type: "text", thought: "", content: "hello all" });

    const aliceCookie = alice.cookie;
    const bobCookie = bob.cookie;

    const read = async (cookie: string) => {
      const res = await req(`/polling/messages?chatId=${chat.id}&lastMessageId=`, "GET", undefined, cookie);
      expect(res.status).toBe(200);
      return ((await res.json()) as { messages: { content: string }[] }).messages.map((m) => m.content);
    };

    expect(await read(aliceCookie)).toContain("psst alice");
    const bobSees = await read(bobCookie);
    expect(bobSees).not.toContain("psst alice");
    expect(bobSees).toContain("hello all");
  });

  it("does not echo private content in whisper validation errors or logs", async () => {
    const alice = await makeUser("error-whisper-alice");
    const created = await req(
      "/chats",
      "POST",
      { participants: [{ role: "ai", name: "bot", model: "m" }] },
      alice.cookie,
    );
    const { chatId } = (await created.json()) as { chatId: string };
    const secret = "PRIVATE_ERROR_WHISPER_SECRET";
    const outputs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const response = await req(
        `/chats/${chatId}/messages`,
        "POST",
        { content: secret, to: ["not-a-participant"] },
        alice.cookie,
      );
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(secret);
      expect(outputs.flatMap((output) => output.mock.calls.flat()).join(" ")).not.toContain(secret);
    } finally {
      for (const output of outputs) output.mockRestore();
    }
  });

  it("keeps a live SSE subscription coherent while two AI generations finish", async () => {
    await stubReplyRouter();
    const alice = await makeUser("multi-ai-sse-alice");
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "alice", userId: alice.userId },
      { role: "ai", name: "bot-one", model: "m", apiRouter: "openai-compat" },
      { role: "ai", name: "bot-two", model: "m", apiRouter: "openai-compat" },
    ]);
    const abort = new AbortController();
    const { api } = await import("../src/api/api.js");
    const response = await api.request(`/chats/${chat.id}/stream?clientId=multi-ai`, {
      headers: { cookie: alice.cookie },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read(); // connected
    const sent = await req(`/chats/${chat.id}/messages`, "POST", { content: "hello both" }, alice.cookie);
    expect(sent.status).toBe(201);
    let wire = "";
    for (let i = 0; i < 40 && (wire.match(/event: done/g) ?? []).length < 2; i++) {
      const next = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 250),
        ),
      ]);
      if (next.done) break;
      wire += new TextDecoder().decode(next.value);
    }
    expect(wire.match(/event: done/g) ?? []).toHaveLength(2);
    expect(wire).toContain('"participantId"');
    abort.abort();
    await reader.cancel();
  });

  it("does not send partial or final human whispers to another SSE connection", async () => {
    await stubReplyRouter();
    const alice = await makeUser("sse-alice");
    const bob = await makeUser("sse-bob");
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "alice", userId: alice.userId },
      { role: "user", name: "bob", userId: bob.userId },
      { role: "ai", name: "bot", model: "m" },
    ]);
    const participants = await chat.getParticipants();
    const aliceParticipant = participants.find((participant) => participant.name === "alice")!;
    const bot = participants.find((participant) => participant.name === "bot")!;
    const { api } = await import("../src/api/api.js");
    const aliceAbort = new AbortController();
    const bobAbort = new AbortController();
    const stream = (cookie: string, signal: AbortSignal) =>
      api.request(`/chats/${chat.id}/stream?clientId=desktop`, {
        headers: { cookie },
        signal,
      });

    const [aliceResponse, bobResponse] = await Promise.all([
      stream(alice.cookie, aliceAbort.signal),
      stream(bob.cookie, bobAbort.signal),
    ]);
    expect(aliceResponse.status).toBe(200);
    expect(bobResponse.status).toBe(200);
    const aliceReader = aliceResponse.body!.getReader();
    const bobReader = bobResponse.body!.getReader();
    // The connection acknowledgement proves both Hono SSE subscriptions are
    // live before we emit the sensitive packets.
    await aliceReader.read();
    await bobReader.read();

    // A raw model chunk arrives before the completed message's @recipient
    // routing is known. Neither connection may receive it over the network.
    chat.emit({ kind: "stream", participantId: bot.id, chunk: { delta: "SSE_SECRET_PARTIAL" } });
    chat.emit({
      kind: "message",
      message: {
        id: "private-message",
        chatId: chat.id,
        authorId: bot.id,
        type: "text",
        thought: "SSE_SECRET_THOUGHT",
        content: "SSE_SECRET_FINAL",
        createdAt: new Date(),
        to: [aliceParticipant.id],
      },
    });

    const aliceChunk = new TextDecoder().decode((await aliceReader.read()).value);
    expect(aliceChunk).toContain("SSE_SECRET_FINAL");
    expect(aliceChunk).not.toContain("SSE_SECRET_PARTIAL");

    chat.emit({
      kind: "stream",
      participantId: bot.id,
      chunk: { delta: "SSE_SCOPED_REPLAY" },
      recipientParticipantIds: [aliceParticipant.id],
    });
    chat.emit({
      kind: "done",
      participantId: bot.id,
      recipientParticipantIds: [aliceParticipant.id],
    });
    const aliceReplay = new TextDecoder().decode((await aliceReader.read()).value);
    expect(aliceReplay).toContain("SSE_SCOPED_REPLAY");

    // Unknown future packet kinds fail closed rather than becoming an
    // unreviewed content side channel.
    chat.emit({ kind: "future_secret_event", content: "SSE_UNKNOWN_SECRET" });

    // The same connection remains live and receives later public traffic.
    chat.emit({
      kind: "message",
      message: {
        id: "public-message",
        chatId: chat.id,
        authorId: bot.id,
        type: "text",
        thought: "",
        content: "SSE_PUBLIC",
        createdAt: new Date(),
      },
    });
    let alicePublic = "";
    let bobChunk = "";
    for (let i = 0; i < 4 && (!alicePublic.includes("SSE_PUBLIC") || !bobChunk.includes("SSE_PUBLIC")); i++) {
      if (!alicePublic.includes("SSE_PUBLIC"))
        alicePublic += new TextDecoder().decode((await aliceReader.read()).value);
      if (!bobChunk.includes("SSE_PUBLIC")) bobChunk += new TextDecoder().decode((await bobReader.read()).value);
    }
    expect(alicePublic).toContain("SSE_PUBLIC");
    expect(alicePublic).not.toContain("SSE_UNKNOWN_SECRET");
    expect(bobChunk).toContain("SSE_PUBLIC");
    expect(bobChunk).not.toContain("SSE_SECRET");
    expect(bobChunk).not.toContain("SSE_UNKNOWN_SECRET");
    expect(bobChunk).not.toContain("SSE_SCOPED_REPLAY");

    // Audio readiness carries the same finalized scope; a non-recipient must
    // not receive the playback token or event bytes.
    chat.emit({
      kind: "audio_ready",
      participantId: bot.id,
      token: "SSE_AUDIO_SECRET_TOKEN",
      recipientParticipantIds: [aliceParticipant.id],
    });
    chat.emit({
      kind: "message",
      message: {
        id: "audio-public-message",
        chatId: chat.id,
        authorId: bot.id,
        type: "text",
        thought: "",
        content: "SSE_AUDIO_PUBLIC",
        createdAt: new Date(),
      },
    });
    let bobAudio = "";
    for (let i = 0; i < 3 && !bobAudio.includes("SSE_AUDIO_PUBLIC"); i++)
      bobAudio += new TextDecoder().decode((await bobReader.read()).value);
    expect(bobAudio).toContain("SSE_AUDIO_PUBLIC");
    expect(bobAudio).not.toContain("SSE_AUDIO_SECRET_TOKEN");

    aliceAbort.abort();
    bobAbort.abort();
    await aliceReader.cancel();
    await bobReader.cancel();

    // A fresh SSE connection also starts clean: it cannot recover a private
    // packet that was emitted before it connected.
    const reconnectAbort = new AbortController();
    const reconnectResponse = await stream(bob.cookie, reconnectAbort.signal);
    const reconnectReader = reconnectResponse.body!.getReader();
    await reconnectReader.read();
    chat.emit({
      kind: "message",
      message: {
        id: "reconnect-public-message",
        chatId: chat.id,
        authorId: bot.id,
        type: "text",
        thought: "",
        content: "SSE_PUBLIC_AFTER_RECONNECT",
        createdAt: new Date(),
      },
    });
    const reconnectChunk = new TextDecoder().decode((await reconnectReader.read()).value);
    expect(reconnectChunk).toContain("SSE_PUBLIC_AFTER_RECONNECT");
    expect(reconnectChunk).not.toContain("SSE_SECRET");
    reconnectAbort.abort();
    await reconnectReader.cancel();
  });

  it("delivers chat deletion only to the matching live SSE connection", async () => {
    const alice = await makeUser("deleted-sse-alice");
    const bob = await makeUser("deleted-sse-bob");
    const { createChat } = await import("../src/chat/chat.js");
    const chat = await createChat([
      { role: "user", name: "alice", userId: alice.userId },
      { role: "user", name: "bob", userId: bob.userId },
    ]);
    const unrelatedChat = await createChat([{ role: "user", name: "bob", userId: bob.userId }]);
    const { api } = await import("../src/api/api.js");
    const aliceAbort = new AbortController();
    const bobAbort = new AbortController();
    const stream = (cookie: string, signal: AbortSignal) =>
      api.request(`/chats/${unrelatedChat.id}/stream?clientId=deleted-test`, {
        headers: { cookie },
        signal,
      });
    const aliceResponse = await api.request(`/chats/${chat.id}/stream?clientId=deleted-test`, {
      headers: { cookie: alice.cookie },
      signal: aliceAbort.signal,
    });
    const bobResponse = await stream(bob.cookie, bobAbort.signal);
    expect(aliceResponse.status).toBe(200);
    expect(bobResponse.status).toBe(200);
    const aliceReader = aliceResponse.body!.getReader();
    const bobReader = bobResponse.body!.getReader();
    await aliceReader.read();
    await bobReader.read();

    chat.emit({ kind: "deleted", chatId: chat.id });
    const deleted = new TextDecoder().decode((await aliceReader.read()).value);
    expect(deleted).toContain("event: deleted");
    expect(deleted).toContain(chat.id);

    const unrelated = await Promise.race([
      bobReader.read().then(({ value }) => new TextDecoder().decode(value)),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 50)),
    ]);
    expect(unrelated).not.toContain("event: deleted");
    aliceAbort.abort();
    bobAbort.abort();
    await aliceReader.cancel();
    await bobReader.cancel();
  });
});

describe("ai participant patch", () => {
  it("toggles readsOthersThoughts for members and rejects bad payloads", async () => {
    await stubReplyRouter();
    const alice = await makeUser("alice3");
    let res = await req("/chats", "POST", { participants: [{ role: "ai", name: "bot", model: "m" }] }, alice.cookie);
    const { chatId } = (await res.json()) as { chatId: string };
    const parts = await (await import("../src/chat/database.js")).getParticipantsRows(chatId);
    const bot = parts.find((p) => p.role === "ai")!;

    expect((bot as { readsOthersThoughts?: boolean }).readsOthersThoughts).toBe(false);

    res = await req(`/chats/${chatId}/participants/${bot.id}`, "PATCH", { readsOthersThoughts: true }, alice.cookie);
    expect(res.status).toBe(200);
    const after = (await (await import("../src/chat/database.js")).getParticipantsRows(chatId)).find(
      (p) => p.id === bot.id,
    ) as { readsOthersThoughts?: boolean };
    expect(after.readsOthersThoughts).toBe(true);

    // invalid payload -> 400; unknown participant -> 404
    res = await req(`/chats/${chatId}/participants/${bot.id}`, "PATCH", {}, alice.cookie);
    expect(res.status).toBe(400);
    res = await req(`/chats/${chatId}/participants/nope`, "PATCH", { readsOthersThoughts: true }, alice.cookie);
    expect(res.status).toBe(404);
  });
});

describe("chat settings patch", () => {
  it("rejects malformed settings without mutating chat state", async () => {
    const alice = await makeUser("settings-validation-alice");
    const created = await req(
      "/chats",
      "POST",
      { participants: [{ role: "ai", name: "bot", model: "m" }] },
      alice.cookie,
    );
    const { chatId } = (await created.json()) as { chatId: string };

    const response = await req(
      `/chats/${chatId}/settings`,
      "PATCH",
      { userInterruptions: "yes", unexpectedSetting: true },
      alice.cookie,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("validation_error");

    const chat = await (await import("../src/chat/chat.js")).getChat(chatId);
    expect(chat.settings).toMatchObject({ userInterruptions: true, aiInterruptions: false, forceAiReply: false });
  });
});
