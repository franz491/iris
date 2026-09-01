import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const config = {
  schemaVersion: 1,
  server: { host: "127.0.0.1", port: 3000, publicUrl: "http://localhost:3000", trustedOrigins: [] },
  services: [],
  profiles: [],
  secrets: {},
  tools: {},
  prompts: {},
  cache: { enabled: false, maxAgeSeconds: 0, maxBytes: 0 },
};
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-boundary-"));
  vi.resetModules();
});

describe("production persist boundaries", () => {
  it.each([
    ["journal_prepared", "prepared"],
    ["setup_written", "prepared"],
    ["providers_projected", "failed"],
    ["admin_committed", "admin_committed"],
    ["journal_terminal", "admin_committed"],
  ])("apply fault at %s persists %s and recovers", async (boundary, phase) => {
    const store = await import("../src/admin/store.js");
    const staged = store.stagePatch("boundary", {
      ...config,
      server: { ...config.server, port: 3001 },
      tools: { files: { active: ["read_file"], allowed: ["read_file", "create_file"] } },
    });
    const validated = store.validatePatch(staged.id, "boundary", true);
    for (const kind of (store.getPatch(validated.id)!.redactedDiff as { _approvals: { required: string[] } })._approvals
      .required)
      store.approvePatch(validated.id, "boundary", kind);
    await expect(
      store.applyPatch(validated.id, "boundary", (name) => {
        if (name === boundary) throw new Error("fault");
      }),
    ).rejects.toThrow("fault");
    const row = store.sqlite
      .prepare("SELECT phase FROM admin_reconciliation_journal WHERE patch_id=?")
      .get(validated.id) as { phase: string };
    expect(row.phase).toBe(phase);
    expect(store.getPatch(validated.id)!.status).toBe(phase === "admin_committed" ? "applied" : "tested");
    expect(store.getAdminConfig().config.server.port).toBe(phase === "admin_committed" ? 3001 : 3000);
    const journal = store.sqlite
      .prepare("SELECT intended_providers FROM admin_reconciliation_journal WHERE patch_id=?")
      .get(validated.id) as { intended_providers: string };
    expect(JSON.parse(journal.intended_providers)).toEqual(
      ["journal_prepared", "prepared"].includes(phase)
        ? []
        : [{ name: "files", activeFunctionalities: ["read_file"], additionalSettings: expect.any(Object) }],
    );
    if (phase === "failed") return;
    await store.recoverReconciliationJournal();
    expect(
      (
        store.sqlite.prepare("SELECT phase FROM admin_reconciliation_journal WHERE patch_id=?").get(validated.id) as {
          phase: string;
        }
      ).phase,
    ).toBe("recovered");
    await store.recoverReconciliationJournal();
  });

  it.each([
    ["rollback_setup_written", "prepared"],
    ["rollback_providers_projected", "failed"],
    ["rollback_admin_committed", "admin_committed"],
    ["rollback_journal_terminal", "admin_committed"],
  ])("rollback fault at %s persists %s and recovers", async (boundary, phase) => {
    const store = await import("../src/admin/store.js");
    const staged = store.stagePatch("boundary", {
      ...config,
      server: { ...config.server, port: 3001 },
      tools: { files: { active: ["read_file"], allowed: ["read_file", "create_file"] } },
    });
    const validated = store.validatePatch(staged.id, "boundary", true);
    for (const kind of (store.getPatch(validated.id)!.redactedDiff as { _approvals: { required: string[] } })._approvals
      .required)
      store.approvePatch(validated.id, "boundary", kind);
    await store.applyPatch(validated.id, "boundary");
    await expect(
      store.rollback("boundary", validated.id, {
        reconcileProviders: async () => undefined,
        faultAt: (name) => {
          if (name === boundary) throw new Error("fault");
        },
      }),
    ).rejects.toThrow("fault");
    const row = store.sqlite
      .prepare("SELECT phase FROM admin_reconciliation_journal WHERE patch_id=?")
      .get(validated.id) as { phase: string };
    expect(row.phase).toBe(phase);
    const state = store.getAdminConfig();
    expect(state.version).toBe(phase === "admin_committed" ? 3 : 2);
    expect(store.getPatch(validated.id)!.status).toBe(phase === "admin_committed" ? "rolled-back" : "applied");
    const auditCount = (
      store.sqlite.prepare("SELECT COUNT(*) count FROM admin_audit WHERE patch_id=?").get(validated.id) as {
        count: number;
      }
    ).count;
    expect(auditCount).toBeGreaterThanOrEqual(1);
    const rollbackAudit = store.sqlite
      .prepare("SELECT action FROM admin_audit WHERE patch_id=?")
      .all(validated.id) as Array<{ action: string }>;
    expect(rollbackAudit.some((entry) => entry.action === "patch.rolled_back")).toBe(false);
    if (phase === "admin_committed") {
      await store.recoverReconciliationJournal();
      expect(
        (
          store.sqlite.prepare("SELECT phase FROM admin_reconciliation_journal WHERE patch_id=?").get(validated.id) as {
            phase: string;
          }
        ).phase,
      ).toBe("recovered");
      await store.recoverReconciliationJournal();
    }
  });
});
