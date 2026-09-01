import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-bridge-"));
  vi.resetModules();
});
describe("admin legacy bridge", () =>
  it("seeds and synchronizes existing setup settings", async () => {
    const s = await import("../src/admin/store.js");
    const current = s.getAdminConfig();
    expect(current.config.server.host).toBe("127.0.0.1");
    const next = { ...current.config, server: { ...current.config.server, port: 3999 } };
    const p = s.stagePatch("admin", next);
    s.validatePatch(p.id, "admin", true);
    const approvals = (s.getPatch(p.id)!.redactedDiff as any)._approvals.required;
    for (const kind of approvals) if (kind !== "standard") s.approvePatch(p.id, "admin", kind);
    await s.applyPatch(p.id, "admin");
    const saved = JSON.parse(readFileSync(path.join(process.env.IRIS_DATA_DIR!, "setup.json"), "utf8"));
    expect(saved.server.port).toBe(3999);
  }));
