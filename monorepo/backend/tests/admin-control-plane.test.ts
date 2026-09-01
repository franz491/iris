import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-admin-"));
  vi.resetModules();
});

const config = {
  schemaVersion: 1,
  server: { host: "127.0.0.1", port: 3000, publicUrl: "http://localhost:3000", trustedOrigins: [] },
  services: [],
  profiles: [],
  secrets: { openaiApiKey: "configured" },
  tools: {},
  prompts: {},
  cache: { enabled: false, maxAgeSeconds: 0, maxBytes: 0 },
};

describe("admin control-plane foundation", () => {
  it("maps AI-facing tool names to provider functionality ids", async () => {
    const { providerFunctionalities } = await import("../src/chat/tools.js");
    expect(providerFunctionalities("tts", ["synthesize_speech"])).toEqual(["synthesize"]);
    expect(providerFunctionalities("tts", ["synthesize"])).toEqual(["synthesize"]);
  });
  it("redacts secrets and requires validate/test before apply", async () => {
    const store = await import("../src/admin/store.js");
    const staged = store.stagePatch("admin-1", config);
    expect(staged.redactedDiff).toMatchObject({ secrets: { openaiApiKey: "configured" } });
    await expect(store.applyPatch(staged.id, "admin-1")).rejects.toThrow(/validated/);
    const tested = store.validatePatch(staged.id, "admin-1", true);
    store.approvePatch(tested.id, "admin-1", "network");
    expect((await store.applyPatch(tested.id, "admin-1")).status).toBe("applied");
    expect(store.getAdminConfig().version).toBe(2);
    expect(store.listAudit().map((x) => x.action)).toEqual(
      expect.arrayContaining(["patch.staged", "patch.tested", "patch.applied"]),
    );
  });

  it("rejects stale patches", async () => {
    const store = await import("../src/admin/store.js");
    const first = store.stagePatch("a", config);
    store.validatePatch(first.id, "a");
    if ((store.getPatch(first.id)!.redactedDiff as any)._approvals.required.includes("network"))
      store.approvePatch(first.id, "a", "network");
    await store.applyPatch(first.id, "a");
    const stale = store.stagePatch("a", config);
    const second = store.stagePatch("a", config);
    store.validatePatch(second.id, "a");
    if ((store.getPatch(second.id)!.redactedDiff as any)._approvals.required.includes("network"))
      store.approvePatch(second.id, "a", "network");
    await store.applyPatch(second.id, "a");
    expect(() => store.validatePatch(stale.id, "a")).toThrow(/stale/);
  });
  it("serializes genuinely approved concurrent applies", async () => {
    const store = await import("../src/admin/store.js");
    const candidate = {
      ...config,
      services: [
        {
          name: "llm",
          kind: "llm",
          mode: "connect-only",
          endpoint: { baseUrl: "http://127.0.0.1:1", healthCheck: { protocol: "http" }, startupTimeoutSeconds: 1 },
        },
      ],
    };
    const first = store.stagePatch("a", candidate);
    const second = store.stagePatch("a", { ...candidate, server: { ...candidate.server, port: 3001 } });
    for (const patch of [first, second]) {
      store.validatePatch(patch.id, "a");
      store.approvePatch(patch.id, "a", "network");
    }
    const results = await Promise.allSettled([store.applyPatch(first.id, "a"), store.applyPatch(second.id, "a")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")[0]).toMatchObject({
      reason: expect.objectContaining({ message: "patch is stale" }),
    });
    expect(store.getAdminConfig().version).toBe(2);
    expect(store.listAudit().filter((entry) => entry.action === "patch.applied")).toHaveLength(1);
  });
  it("rejects rollback of a non-current patch without projection drift", async () => {
    const store = await import("../src/admin/store.js");
    const patch = store.stagePatch("a", { ...config, cache: { enabled: true, maxAgeSeconds: 1, maxBytes: 1 } });
    store.validatePatch(patch.id, "a");
    store.approvePatch(patch.id, "a", "network");
    await store.applyPatch(patch.id, "a");
    const before = store.getAdminConfig();
    await store.rollback("a", patch.id);
    const after = store.getAdminConfig();
    expect(after.version).toBe(before.version + 1);
    const setup = await import("../src/setup/settings.js");
    const restored = setup.readSetupSettings();
    await expect(store.rollback("a", patch.id)).rejects.toThrow(/snapshot/);
    expect(store.getAdminConfig()).toEqual(after);
    expect(setup.readSetupSettings()).toEqual(restored);
  });
  it("leaves setup/admin projections unchanged when provider probe fails", async () => {
    const store = await import("../src/admin/store.js");
    const { readSetupSettings } = await import("../src/setup/settings.js");
    const before = readSetupSettings();
    const staged = store.stagePatch("admin-1", {
      ...config,
      services: [
        {
          name: "llm",
          kind: "llm",
          mode: "connect-only",
          endpoint: { baseUrl: "http://127.0.0.1:1", healthCheck: { protocol: "http" }, startupTimeoutSeconds: 1 },
        },
      ],
    });
    await expect(store.testPatch(staged.id, "admin-1")).rejects.toThrow();
    expect(readSetupSettings()).toEqual(before);
    expect(store.getAdminConfig().version).toBe(1);
    expect(store.listAudit().some((entry) => entry.action === "patch.applied")).toBe(false);
  });

  it("updates setup projection, admin version, audit, and resolver on successful apply", async () => {
    const store = await import("../src/admin/store.js");
    const { readSetupSettings } = await import("../src/setup/settings.js");
    const { resolveProviderBaseUrl } = await import("../src/config/runtime.js");
    const staged = store.stagePatch("admin-1", {
      ...config,
      server: { ...config.server, publicUrl: "http://admin.example.test" },
      services: [
        {
          name: "llm",
          kind: "llm",
          mode: "connect-only",
          endpoint: { baseUrl: "http://127.0.0.1:1", healthCheck: { protocol: "http" }, startupTimeoutSeconds: 1 },
        },
      ],
      profiles: [{ name: "default", service: "llm", model: "default", acceleration: "cpu" }],
    });
    store.validatePatch(staged.id, "admin-1");
    store.approvePatch(staged.id, "admin-1", "network");
    const applied = await store.applyPatch(staged.id, "admin-1");
    const setup = readSetupSettings();
    expect(applied.status).toBe("applied");
    expect(setup.defaultModel.model).toBe("default");
    expect(store.getAdminConfig().version).toBe(2);
    expect(store.listAudit().some((entry) => entry.action === "patch.applied")).toBe(true);
    expect(resolveProviderBaseUrl(setup, "llamacpp")).toBe(setup.modelProviders.llamacppBaseUrl);
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const journal = openDb(dataFile("admin.db"))
      .sqlite.prepare(
        "SELECT operation,phase,prior_admin,applied_admin,prior_setup,applied_setup,intended_providers FROM admin_reconciliation_journal WHERE patch_id=?",
      )
      .get(staged.id) as Record<string, string>;
    expect(journal).toMatchObject({ operation: "apply", phase: "committed" });
    expect(JSON.parse(journal.prior_admin).config).toMatchObject({ schemaVersion: 1 });
    expect(JSON.parse(journal.applied_admin).config).toMatchObject({ schemaVersion: 1 });
    expect(JSON.parse(journal.prior_setup)).toMatchObject({ version: 1 });
    expect(JSON.parse(journal.applied_setup)).toMatchObject({ version: 1 });
    expect(JSON.parse(journal.intended_providers)).toEqual([]);
  });
  it("restores the prior config from an applied snapshot", async () => {
    const store = await import("../src/admin/store.js");
    const { readSetupSettings } = await import("../src/setup/settings.js");
    const beforeSetup = readSetupSettings();
    const first = store.stagePatch("a", { ...config, cache: { enabled: true, maxAgeSeconds: 10, maxBytes: 100 } });
    store.validatePatch(first.id, "a");
    store.approvePatch(first.id, "a", "network");
    await store.applyPatch(first.id, "a");
    expect(store.getAdminConfig().config.cache.enabled).toBe(true);
    const rolledBack = await store.rollback("a", first.id);
    expect(store.getAdminConfig().config.cache.enabled).toBe(false);
    expect(rolledBack.status).toBe("rolled-back");
    expect(readSetupSettings()).toEqual(beforeSetup);
    expect(store.getPatch(first.id)?.status).toBe("rolled-back");
    expect(store.listAudit().map((entry) => entry.action)).toContain("patch.rolled_back");
  });
  it("fails closed when a persisted approval row is malformed", async () => {
    const store = await import("../src/admin/store.js");
    const staged = store.stagePatch("admin-1", config);
    store.validatePatch(staged.id, "admin-1");
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const sqlite = openDb(dataFile("admin.db")).sqlite;
    sqlite
      .prepare("INSERT INTO admin_patch_approvals VALUES (?,?,?,?)")
      .run(staged.id, 42, "admin-1", new Date().toISOString());

    await expect(store.applyPatch(staged.id, "admin-1")).rejects.toThrow();
    expect(store.getAdminConfig().version).toBe(1);
  });

  it("rolls back a legacy config-only snapshot with limited setup behavior", async () => {
    const store = await import("../src/admin/store.js");
    const staged = store.stagePatch("admin-1", {
      ...config,
      cache: { enabled: true, maxAgeSeconds: 10, maxBytes: 100 },
    });
    store.validatePatch(staged.id, "admin-1");
    store.approvePatch(staged.id, "admin-1", "network");
    await store.applyPatch(staged.id, "admin-1");
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const sqlite = openDb(dataFile("admin.db")).sqlite;
    const legacy = JSON.stringify(config);
    sqlite.prepare("UPDATE admin_snapshots SET config=? WHERE patch_id=?").run(legacy, staged.id);
    await store.rollback("admin-1", staged.id);
    expect(store.getAdminConfig().config.cache.enabled).toBe(false);
    expect(store.getPatch(staged.id)?.status).toBe("rolled-back");
  });

  it("keeps an applied patch intact when rollback reconciliation fails", async () => {
    const store = await import("../src/admin/store.js");
    const { readSetupSettings } = await import("../src/setup/settings.js");
    const staged = store.stagePatch("admin-1", config);
    store.validatePatch(staged.id, "admin-1");
    store.approvePatch(staged.id, "admin-1", "network");
    await store.applyPatch(staged.id, "admin-1");
    const appliedSetup = readSetupSettings();
    await expect(
      store.rollback("admin-1", staged.id, {
        reconcileProviders: async () => {
          throw new Error("reconcile failed");
        },
      }),
    ).rejects.toThrow("reconcile failed");
    expect(readSetupSettings()).toEqual(appliedSetup);
    expect(store.getPatch(staged.id)?.status).toBe("applied");
    expect(store.getAdminConfig().version).toBe(2);
    expect(store.listAudit().map((entry) => entry.action)).not.toContain("patch.rolled_back");
  });
  it("fails closed when persisted patch data is malformed", async () => {
    const store = await import("../src/admin/store.js");
    const staged = store.stagePatch("admin-1", config);
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const sqlite = openDb(dataFile("admin.db")).sqlite;

    sqlite.prepare("UPDATE admin_patches SET patch=? WHERE id=?").run("not-json", staged.id);
    expect(() => store.getPatch(staged.id)).toThrow(/malformed persisted patch/);
  });
  it("fails closed when persisted admin config JSON is malformed", async () => {
    const store = await import("../src/admin/store.js");
    store.getAdminConfig();
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const sqlite = openDb(dataFile("admin.db")).sqlite;

    sqlite.prepare("UPDATE admin_state SET config=? WHERE id=1").run("not-json");
    expect(() => store.getAdminConfig()).toThrow(/malformed persisted admin config/);
  });
  it("fails closed when persisted admin config JSON has an invalid shape", async () => {
    const store = await import("../src/admin/store.js");
    store.getAdminConfig();
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const sqlite = openDb(dataFile("admin.db")).sqlite;

    sqlite.prepare("UPDATE admin_state SET config=? WHERE id=1").run(JSON.stringify({ schemaVersion: 1 }));
    expect(() => store.getAdminConfig()).toThrow();
  });
  it("fails closed when the persisted admin config row has an invalid version", async () => {
    const store = await import("../src/admin/store.js");
    store.getAdminConfig();
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const sqlite = openDb(dataFile("admin.db")).sqlite;

    sqlite.prepare("UPDATE admin_state SET version=? WHERE id=1").run("invalid");
    expect(() => store.getAdminConfig()).toThrow();
  });
  it("fails closed when persisted redacted diff data is malformed", async () => {
    const store = await import("../src/admin/store.js");
    const staged = store.stagePatch("admin-1", config);
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const sqlite = openDb(dataFile("admin.db")).sqlite;

    sqlite.prepare("UPDATE admin_patches SET redacted_diff=? WHERE id=?").run(JSON.stringify({}), staged.id);
    expect(() => store.getPatch(staged.id)).toThrow();
  });
  it("fails closed when a persisted audit row has malformed details", async () => {
    const store = await import("../src/admin/store.js");
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const sqlite = openDb(dataFile("admin.db")).sqlite;
    sqlite
      .prepare("INSERT INTO admin_audit VALUES (?,?,?,?,?,?)")
      .run("bad-audit", "admin-1", "malformed", null, "not-json", new Date().toISOString());

    expect(() => store.listAudit()).toThrow();
  });
});
