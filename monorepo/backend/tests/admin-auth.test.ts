import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-admin-auth-"));
  vi.resetModules();
});
describe("admin identity management", () =>
  it("starts with an empty user listing and supports session helpers", async () => {
    const a = await import("../src/api/auth.js");
    expect(a.listAdminUsers()).toEqual([]);
    expect(a.revokeUserSessions("missing")).toBe(0);
    expect(a.setAdminRole("missing", "admin")).toBe(false);
  }));

it("revokes only the target user's active session", async () => {
  const a = await import("../src/api/auth.js");
  const actor = (await a.auth.api.signUpEmail({
    body: { name: "actor", email: "actor@iris.local", password: "long-password-1" },
  })) as any;
  const target = (await a.auth.api.signUpEmail({
    body: { name: "target", email: "target@iris.local", password: "long-password-2" },
  })) as any;
  const sign = async (email: string, password: string) =>
    a.auth.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
  const ar = await sign("actor@iris.local", "long-password-1"),
    tr = await sign("target@iris.local", "long-password-2");
  const ac = ar.headers.get("set-cookie")!,
    tc = tr.headers.get("set-cookie")!;
  expect((await a.auth.api.getSession({ headers: { cookie: ac } })).user.id).toBe(actor.user.id);
  expect((await a.auth.api.getSession({ headers: { cookie: tc } })).user.id).toBe(target.user.id);
  a.revokeUserSessions(target.user.id);
  expect(await a.auth.api.getSession({ headers: { cookie: tc } })).toBeNull();
  expect((await a.auth.api.getSession({ headers: { cookie: ac } })).user.id).toBe(actor.user.id);
});

describe("credential and final-admin policy", () => {
  it("rejects short non-PIN passwords", async () => {
    const { validateCredential, PASSWORD_MIN_LENGTH } = await import("../src/api/auth.js");
    expect(() => validateCredential("short", false)).toThrow(/password/i);
    expect(() => validateCredential("x".repeat(PASSWORD_MIN_LENGTH), false)).not.toThrow();
  });

  it("validates PIN policy and exposes bounded user/session helpers", async () => {
    const {
      validateCredential,
      findUserByName,
      findUsersByIdentifier,
      getUserImage,
      getUserName,
      grantRecentAuth,
      hasRecentAuthGrant,
      listUserSessions,
    } = await import("../src/api/auth.js");
    expect(() => validateCredential("12", true)).toThrow(/PIN/i);
    expect(() => validateCredential("12ab", true)).toThrow(/PIN/i);
    expect(() => validateCredential("1234", true)).not.toThrow();
    expect(() => validateCredential("1234567", true)).toThrow(/PIN/i);

    const a = await import("../src/api/auth.js");
    const created = (await a.auth.api.signUpEmail({
      body: { name: "helpers", email: "helpers@iris.local", password: "long-password-1" },
    })) as { user: { id: string; name: string; email: string } };
    expect(getUserName(created.user.id)).toBe("helpers");
    expect(getUserImage(created.user.id)).toBeNull();
    expect(findUserByName("helpers")).toMatchObject({ id: created.user.id, name: "helpers", image: null });
    expect(findUserByName("missing")).toBeNull();
    expect(findUsersByIdentifier(" HELPERS ")).toEqual([
      expect.objectContaining({ id: created.user.id, email: "helpers@iris.local", role: "user" }),
    ]);
    expect(listUserSessions(created.user.id)).toHaveLength(1);

    grantRecentAuth("session-1", created.user.id, 1_000);
    expect(hasRecentAuthGrant("session-1", created.user.id, 1_001)).toBe(true);
    expect(hasRecentAuthGrant("other-session", created.user.id, 1_001)).toBe(false);
    expect(hasRecentAuthGrant("session-1", created.user.id, 301_001)).toBe(false);
  });

  it("does not permit demotion of the final administrator", async () => {
    const a = await import("../src/api/auth.js");
    const first = (await a.auth.api.signUpEmail({
      body: { name: "first", email: "first@iris.local", password: "long-password-1" },
    })) as { user: { id: string } };
    expect(a.setAdminRole(first.user.id, "admin")).toBe(true);
    expect(a.canRemoveAdmin(first.user.id)).toBe(false);
    expect(a.setAdminRole(first.user.id, "user")).toBe(false);
    const second = (await a.auth.api.signUpEmail({
      body: { name: "second", email: "second@iris.local", password: "long-password-2" },
    })) as { user: { id: string } };
    expect(a.setAdminRole(second.user.id, "admin")).toBe(true);
    expect(a.canRemoveAdmin(first.user.id)).toBe(true);
    expect(a.setAdminRole(first.user.id, "user")).toBe(true);
  });
});

describe("sign-in failure limiter", () => {
  async function signIn(email: string, password: string, source = "198.51.100.10"): Promise<Response> {
    const { auth } = await import("../src/api/auth.js");
    return auth.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", "x-iris-remote-address": source },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  it("blocks the sixth failure with a clear, deterministic response", async () => {
    const { auth } = await import("../src/api/auth.js");
    await auth.api.signUpEmail({ body: { name: "limited", email: "limited@iris.local", password: "long-password-1" } });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await signIn("limited@iris.local", "wrong-password")).status).toBe(401);
    }

    const blocked = await signIn("limited@iris.local", "wrong-password");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("60");
    expect(await blocked.json()).toEqual({
      error: "too_many_sign_in_attempts",
      message: "Too many failed sign-in attempts; try again later.",
    });
  });

  it("keeps account keys independent and supports explicit test reset", async () => {
    const authModule = await import("../src/api/auth.js");
    await authModule.auth.api.signUpEmail({
      body: { name: "one", email: "one@iris.local", password: "long-password-1" },
    });
    await authModule.auth.api.signUpEmail({
      body: { name: "two", email: "two@iris.local", password: "long-password-2" },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await signIn("one@iris.local", "wrong-password", "198.51.100.11")).status).toBe(401);
    }
    expect((await signIn("two@iris.local", "wrong-password", "198.51.100.12")).status).toBe(401);
    expect((await signIn("two@iris.local", "long-password-2", "198.51.100.12")).status).toBe(200);

    authModule.resetSignInFailureLimiter();
    expect((await signIn("one@iris.local", "wrong-password", "198.51.100.11")).status).toBe(401);
  });

  it("expires failures after the bounded window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const { auth } = await import("../src/api/auth.js");
      await auth.api.signUpEmail({
        body: { name: "expiring", email: "expiring@iris.local", password: "long-password-1" },
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await signIn("expiring@iris.local", "wrong-password")).status).toBe(401);
      }
      vi.advanceTimersByTime(60_000);
      expect((await signIn("expiring@iris.local", "wrong-password")).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets an account's failures after a successful login", async () => {
    const { auth } = await import("../src/api/auth.js");
    await auth.api.signUpEmail({ body: { name: "reset", email: "reset@iris.local", password: "long-password-1" } });
    for (let attempt = 0; attempt < 4; attempt += 1)
      expect((await signIn("reset@iris.local", "wrong-password", "198.51.100.20")).status).toBe(401);
    expect((await signIn("reset@iris.local", "long-password-1", "198.51.100.20")).status).toBe(200);
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await signIn("reset@iris.local", "wrong-password", "198.51.100.21")).status).toBe(401);
    expect((await signIn("reset@iris.local", "wrong-password", "198.51.100.21")).status).toBe(429);
  });

  it("enforces the per-source limit independently", async () => {
    const { auth } = await import("../src/api/auth.js");
    await auth.api.signUpEmail({ body: { name: "ip-one", email: "ip-one@iris.local", password: "long-password-1" } });
    await auth.api.signUpEmail({ body: { name: "ip-two", email: "ip-two@iris.local", password: "long-password-2" } });
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await signIn("ip-one@iris.local", "wrong-password", "198.51.100.21")).status).toBe(401);
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect((await signIn("ip-two@iris.local", "wrong-password", "198.51.100.21")).status).toBe(401);
    expect((await signIn("ip-two@iris.local", "wrong-password", "198.51.100.21")).status).toBe(429);
  });

  it("does not let one source lock a known account for another source", async () => {
    const { auth } = await import("../src/api/auth.js");
    await auth.api.signUpEmail({ body: { name: "target", email: "target@iris.local", password: "long-password-1" } });
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await signIn("target@iris.local", "wrong-password", "198.51.100.30")).status).toBe(401);
    expect((await signIn("target@iris.local", "long-password-1", "198.51.100.31")).status).toBe(200);
    expect((await signIn("target@iris.local", "wrong-password", "198.51.100.30")).status).toBe(429);
  });

  it("does not aggregate unrelated accounts when peer identity is unavailable", async () => {
    const { auth } = await import("../src/api/auth.js");
    await auth.api.signUpEmail({
      body: { name: "no-ip-one", email: "no-ip-one@iris.local", password: "long-password-1" },
    });
    await auth.api.signUpEmail({
      body: { name: "no-ip-two", email: "no-ip-two@iris.local", password: "long-password-2" },
    });
    const noSourceSignIn = (email: string) =>
      auth.handler(
        new Request("http://localhost/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, password: "wrong-password" }),
        }),
      );
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await noSourceSignIn("no-ip-one@iris.local")).status).toBe(401);
    expect((await noSourceSignIn("no-ip-two@iris.local")).status).toBe(401);
  });
});

describe("SQLite sign-in limiter contract", () => {
  it("shares state, expires, clears, bounds, and hashes identities", async () => {
    const { SqliteSignInLimiterStore } = await import("../src/api/auth.js");
    const dir = mkdtempSync(path.join(tmpdir(), "iris-limiter-"));
    const db1 = new Database(path.join(dir, "limiter.db"));
    const db2 = new Database(path.join(dir, "limiter.db"));
    const one = new SqliteSignInLimiterStore(db1);
    const two = new SqliteSignInLimiterStore(db2, 100);
    const bounded = two;
    try {
      for (let i = 0; i < 5; i++) one.recordFailure("account:private@example.com", 1_000 + i);
      expect(two.isBlocked("account:private@example.com", 5, 2_000)).toBe(true);
      expect(two.isBlocked("ip:198.51.100.44", 5, 2_000)).toBe(false);
      two.clear("account:private@example.com");
      expect(one.isBlocked("account:private@example.com", 5, 2_000)).toBe(false);
      two.recordFailure("ip:198.51.100.44", 3_000);
      expect(one.isBlocked("ip:198.51.100.44", 1, 3_001)).toBe(true);
      expect(one.isBlocked("ip:198.51.100.44", 1, 63_001)).toBe(false);
      for (let i = 0; i < 105; i++) bounded.recordFailure(`account:key-${i}`, 100_000 + i);
      expect((db2.prepare("SELECT count(*) AS n FROM sign_in_failures").get() as { n: number }).n).toBeLessThanOrEqual(
        100,
      );
      const raw = db2.prepare("SELECT key_hash FROM sign_in_failures").all() as { key_hash: string }[];
      expect(raw.some((r) => r.key_hash.includes("private@example.com") || r.key_hash.includes("198.51.100.44"))).toBe(
        false,
      );
      one.resetAll();
      expect((db2.prepare("SELECT count(*) AS n FROM sign_in_failures").get() as { n: number }).n).toBe(0);
    } finally {
      db1.close();
      db2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
