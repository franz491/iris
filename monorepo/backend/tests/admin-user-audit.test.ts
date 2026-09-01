import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-user-audit-"));
  vi.resetModules();
});

describe("admin user mutation audit", () => {
  it("records actor, target, action, and outcome without secrets", async () => {
    const store = await import("../src/admin/store.js");
    const entry = store.auditUserMutation("actor-1", "target-2", "password_reset");
    expect(entry.action).toBe("user.password_reset");
    expect(entry.actorId).toBe("actor-1");
    expect(entry.details).toEqual({ targetId: "target-2", outcome: "success" });
    expect(JSON.stringify(entry.details)).not.toMatch(/secret|credential|value/i);
    const failure = store.auditUserMutation("actor-1", "target-2", "user_deleted", "failure");
    expect(failure.details).toEqual({ targetId: "target-2", outcome: "failure" });
  });

  it("re-redacts legacy secret-bearing rows when exporting audit entries", async () => {
    const store = await import("../src/admin/store.js");
    store.sqlite
      .prepare("INSERT INTO admin_audit VALUES (?,?,?,?,?,?)")
      .run(
        "legacy-1",
        "actor-1",
        "legacy.action",
        null,
        JSON.stringify({ apiKey: "sk-live-secret", note: "ok" }),
        new Date().toISOString(),
      );

    const entry = store.listAudit().find((item) => item.id === "legacy-1");
    expect(entry?.details).toEqual({ apiKey: "configured", note: "ok" });
    expect(JSON.stringify(entry)).not.toContain("sk-live-secret");
  });
});
