import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-bootstrap-"));
  vi.resetModules();
});
describe("bootstrap token", () =>
  it("expires only after one successful consume", async () => {
    const b = await import("../src/admin/bootstrap.js");
    const t = b.issueBootstrapToken(60);
    expect(b.bootstrapAvailable()).toBe(true);
    expect(b.consumeBootstrapToken(t)).toBe(true);
    expect(b.consumeBootstrapToken(t)).toBe(false);
    expect(b.bootstrapAvailable()).toBe(false);
  }));

describe("bootstrap reservations", () =>
  it("releases a failed account-creation claim without exposing the token", async () => {
    const b = await import("../src/admin/bootstrap.js");
    const t = b.issueBootstrapToken(60);
    expect(b.claimBootstrapToken(t)).toBe(true);
    expect(b.bootstrapAvailable()).toBe(false);
    b.releaseBootstrapToken(t);
    expect(b.bootstrapAvailable()).toBe(true);
    expect(b.claimBootstrapToken(t)).toBe(true);
    b.completeBootstrapToken(t);
    expect(b.bootstrapAvailable()).toBe(false);
  }));

describe("bootstrap HTTP flow", () => {
  it("creates the first admin with default trusted origins", async () => {
    const { adminApi } = await import("../src/api/admin.js");
    const { issueBootstrapToken } = await import("../src/admin/bootstrap.js");
    const token = issueBootstrapToken();
    const status = await adminApi.request("/bootstrap/status", { headers: { origin: "tauri://localhost" } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ configured: false, available: true });
    const response = await adminApi.request("/bootstrap/create-admin", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "tauri://localhost" },
      body: JSON.stringify({ token, name: "admin", password: "password-123456" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, email: "admin@iris.local" });
    const { auth } = await import("../src/api/auth.js");
    const signIn = await auth.api.signInEmail({
      body: { email: "admin@iris.local", password: "password-123456" },
      asResponse: true,
    });
    expect(signIn.status).toBe(200);
  });
});
