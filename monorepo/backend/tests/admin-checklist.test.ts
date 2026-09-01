import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-check-"));
  vi.resetModules();
});
describe("admin checklist", () =>
  it("seeds schema-owned items and updates explicit state", async () => {
    const s = await import("../src/admin/store.js");
    expect(s.getChecklist().length).toBeGreaterThan(5);
    expect(s.setChecklistState("foundation", "verified").state).toBe("verified");
  }));
