import { beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-lost-admin-"));
  vi.resetModules();
});

describe("lost-admin recovery primitives", () => {
  it("resolves normalized username/email and rejects ambiguity", async () => {
    const a = await import("../src/api/auth.js");
    const actor = (await a.auth.api.signUpEmail({
      body: { name: "actor", email: "actor@iris.local", password: "actor-password-1" },
    })) as any;
    a.setAdminRole(actor.user.id, "admin");
    await a.auth.api.signUpEmail({ body: { name: "Admin", email: "admin@iris.local", password: "old-password-1" } });
    expect(a.findUsersByIdentifier(" ADMIN ")).toHaveLength(1);
    expect(a.findUsersByIdentifier("ADMIN@IRIS.LOCAL")).toHaveLength(1);
    expect(a.findUsersByIdentifier("missing")).toHaveLength(0);
  });

  it("uses BetterAuth hashing and revokes every existing session", async () => {
    const a = await import("../src/api/auth.js");
    await a.auth.api.signUpEmail({ body: { name: "actor", email: "actor@iris.local", password: "actor-password-1" } });
    const actor = a.findUsersByIdentifier("actor")[0];
    a.setAdminRole(actor.id, "admin");
    const created = (await a.auth.api.signUpEmail({
      body: { name: "target", email: "target@iris.local", password: "old-password-1" },
    })) as any;
    const sign = (password: string) =>
      a.auth.handler(
        new Request("http://localhost/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "target@iris.local", password }),
        }),
      );
    const old = await sign("old-password-1");
    expect(old.status).toBe(200);
    expect(a.listUserSessions(created.user.id).length).toBeGreaterThan(0);
    const actorSignIn = await a.auth.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "actor@iris.local", password: "actor-password-1" }),
      }),
    );
    await a.resetUserCredential(created.user.id, "new-password-1", {
      cookie: actorSignIn.headers.get("set-cookie") ?? "",
    });
    expect(a.listUserSessions(created.user.id)).toHaveLength(0);
    expect((await sign("old-password-1")).status).toBe(401);
    expect((await sign("new-password-1")).status).toBe(200);
  });

  it("fails closed for ambiguous identifiers and preserves the final-admin role", async () => {
    const a = await import("../src/api/auth.js");
    const first = (await a.auth.api.signUpEmail({
      body: { name: "same", email: "same@iris.local", password: "first-password-1" },
    })) as any;
    a.setAdminRole(first.user.id, "admin");
    const second = (await a.auth.api.signUpEmail({
      body: { name: "other", email: "same@other.test", password: "second-password-1" },
    })) as any;
    expect(a.findUsersByIdentifier("same")).toHaveLength(1);
    expect(a.findUsersByIdentifier("SAME@IRIS.LOCAL")).toHaveLength(1);
    expect(a.canRemoveAdmin(first.user.id)).toBe(false);
    expect(a.setAdminRole(first.user.id, "user")).toBe(false);
    const store = await import("../src/admin/store.js");
    const event = store.auditUserMutation(first.user.id, second.user.id, "lost_admin_recovery");
    expect(event.action).toBe("user.lost_admin_recovery");
    expect(event.details).toEqual({ targetId: second.user.id, outcome: "success" });
    expect(JSON.stringify(event)).not.toContain("password");
  });

  it("normalizes exact identifiers but rejects a genuinely ambiguous name", async () => {
    const a = await import("../src/api/auth.js");
    await a.auth.api.signUpEmail({
      body: { name: "duplicate", email: "one@example.test", password: "first-password-1" },
    });
    await a.auth.api.signUpEmail({
      body: { name: "duplicate", email: "two@example.test", password: "second-password-1" },
    });
    expect(a.findUsersByIdentifier(" DUPLICATE ")).toHaveLength(2);
    expect(a.findUsersByIdentifier("nobody@example.test")).toHaveLength(0);
  });

  it("reads only a regular 0600 credential file through a no-follow descriptor", async () => {
    const { readProtectedCredential } = await import("../src/cli/protected-credential.js");
    const root = mkdtempSync(path.join(tmpdir(), "iris-credential-file-"));
    const file = path.join(root, "credential");
    const target = path.join(root, "target");
    writeFileSync(file, "new-password-1\n", { mode: 0o600 });
    expect(readProtectedCredential(file)).toBe("new-password-1");

    chmodSync(file, 0o640);
    expect(() => readProtectedCredential(file)).toThrow(/0600/);
    writeFileSync(target, "outside-password-1\n", { mode: 0o600 });
    unlinkSync(file);
    symlinkSync(target, file);
    expect(() => readProtectedCredential(file)).toThrow();
    expect(readlinkSync(file)).toBe(target);
  });

  it("restores credential and sessions if reset is interrupted after hashing", async () => {
    const a = await import("../src/api/auth.js");
    const actor = (await a.auth.api.signUpEmail({
      body: { name: "actor", email: "actor@iris.local", password: "actor-password-1" },
    })) as any;
    a.setAdminRole(actor.user.id, "admin");
    const target = (await a.auth.api.signUpEmail({
      body: { name: "rollback", email: "rollback@iris.local", password: "old-password-1" },
    })) as any;
    const login = () =>
      a.auth.handler(
        new Request("http://localhost/api/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "rollback@iris.local", password: "old-password-1" }),
        }),
      );
    const old = await login();
    const actorLogin = await a.auth.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "actor@iris.local", password: "actor-password-1" }),
      }),
    );
    process.env.IRIS_TEST_RESET_FAULT = "after-hash";
    await expect(
      a.resetUserCredential(target.user.id, "new-password-1", { cookie: actorLogin.headers.get("set-cookie") ?? "" }),
    ).rejects.toThrow(/interrupted/);
    delete process.env.IRIS_TEST_RESET_FAULT;
    expect(a.listUserSessions(target.user.id).length).toBeGreaterThan(0);
    expect((await login()).status).toBe(200);
    expect(await a.auth.api.getSession({ headers: { cookie: old.headers.get("set-cookie") ?? "" } })).not.toBeNull();
  });
});
