import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-recent-auth-"));
  process.env.IRIS_BETTER_AUTH_SECRET = "test-secret-0123456789";
  process.env.IRIS_TRUSTED_ORIGINS = "http://localhost";
  vi.resetModules();
});

async function account(name: string) {
  const a = await import("../src/api/auth.js");
  const password = "correct-password-123";
  const created = await a.auth.api.signUpEmail({ body: { name, email: `${name}@iris.local`, password } });
  a.setAdminRole(created.user.id, "admin");
  const response = await a.auth.api.signInEmail({ body: { email: `${name}@iris.local`, password }, asResponse: true });
  return { a, userId: created.user.id, password, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

describe("recent authentication", () => {
  it("keeps the high-risk admin route policy explicit", async () => {
    const { requiresRecentAuthPath } = await import("../src/api/admin.js");
    for (const [method, path] of [
      ["POST", "/software/comfyui/install"],
      ["DELETE", "/models/model-id"],
      ["POST", "/services/service/start"],
      ["POST", "/services/service/stop"],
      ["POST", "/models"],
      ["POST", "/patches/patch-id/approve"],
      ["POST", "/patches/patch-id/apply"],
      ["POST", "/patches/patch-id/rollback"],
      ["POST", "/reset-defaults"],
    ] as const) {
      expect(requiresRecentAuthPath(method, path), `${method} ${path}`).toBe(true);
    }
    expect(requiresRecentAuthPath("GET", "/models/model-id")).toBe(false);
    expect(requiresRecentAuthPath("delete", "/models/model-id")).toBe(true);
    expect(requiresRecentAuthPath("POST", "/nested/services/service/start")).toBe(false);
    expect(requiresRecentAuthPath("POST", "/services/service/start/extra")).toBe(false);
    expect(requiresRecentAuthPath("POST", "/users/user-idle")).toBe(true);
    expect(requiresRecentAuthPath("POST", "/reauth")).toBe(false);
    expect(requiresRecentAuthPath("POST", "/setup/proposals")).toBe(false);
  });

  it("rejects stale high-risk mutations before handler work and allows a fresh grant", async () => {
    const { a, userId, cookie } = await account("high-risk");
    a.setAdminRole(userId, "admin");
    const { adminApi } = await import("../src/api/admin.js");
    const init = {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
    };
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    const stale = await adminApi.request("/services/missing/start", { ...init, body: "{}" });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "recent_auth_required" });
    vi.useRealTimers();

    const session = await a.auth.api.getSession({ headers: { cookie } });
    expect(session).not.toBeNull();
    a.grantRecentAuth(session!.session.id, userId);
    // A nonexistent service is a side-effect-free route target; reaching its
    // normal 404 proves the recent-auth gate no longer blocks a valid grant.
    const fresh = await adminApi.request("/services/missing/start", { ...init, body: "{}" });
    expect(fresh.status).toBe(404);
  });

  it("allows a fresh session and denies a stale one", async () => {
    const { a, userId, cookie } = await account("fresh");
    await expect(
      (await import("../src/api/api.js")).requireRecentAuth(new Request("http://x", { headers: { cookie } })),
    ).resolves.toEqual({ userId });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
    await expect(
      (await import("../src/api/api.js")).requireRecentAuth(new Request("http://x", { headers: { cookie } })),
    ).rejects.toThrow();
    vi.useRealTimers();
    expect(a.hasRecentAuthGrant("missing", userId)).toBe(false);
  });

  it("creates a grant only after correct reauth and enforces origin/CSRF", async () => {
    const { a, userId, password, cookie } = await account("reauth");
    const { adminApi } = await import("../src/api/admin.js");
    const wrong = await adminApi.request("/reauth", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(wrong.status).toBe(401);
    const noOrigin = await adminApi.request("/reauth", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    expect(noOrigin.status).toBe(403);
    const ok = await adminApi.request("/reauth", {
      method: "POST",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    expect(ok.status).toBe(200);
    const session = await a.auth.api.getSession({ headers: { cookie } });
    expect(session).not.toBeNull();
    expect(a.hasRecentAuthGrant(session!.session.id, userId)).toBe(true);
  });

  it("expires, cleans, and binds grants to both session and user", async () => {
    const { a, userId } = await account("bound");
    a.grantRecentAuth("session-a", userId, 1_000);
    expect(a.hasRecentAuthGrant("session-a", userId, 1_001)).toBe(true);
    expect(a.hasRecentAuthGrant("session-b", userId, 1_001)).toBe(false);
    expect(a.hasRecentAuthGrant("session-a", "other-user", 1_001)).toBe(false);
    expect(a.hasRecentAuthGrant("session-a", userId, 301_001)).toBe(false);
    const db = new Database(path.join(process.env.IRIS_DATA_DIR!, "auth.db"));
    expect((db.prepare("SELECT COUNT(*) AS n FROM recent_auth_grants").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("loses practical access when its session is revoked", async () => {
    const { a, userId, cookie } = await account("revoked");
    const session = await a.auth.api.getSession({ headers: { cookie } });
    a.grantRecentAuth(session!.session.id, userId);
    a.revokeUserSessions(userId);
    await expect(
      (await import("../src/api/api.js")).requireRecentAuth(new Request("http://x", { headers: { cookie } })),
    ).rejects.toThrow();
  });
});
