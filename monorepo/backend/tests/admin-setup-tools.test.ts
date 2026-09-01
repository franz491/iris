import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-setup-tools-"));
  vi.resetModules();
});
describe("constrained setup tools", () => {
  it("never returns secret values", async () => {
    const s = await import("../src/admin/setup-tools.js");
    expect(s.setupListSections()).toContain("secrets");
    expect(s.setupReadSection("secrets")).toEqual({});
    expect(s.setupGetOptions("services")).toHaveProperty("modes");
  });
  it("reads only known setup sections", async () => {
    const s = await import("../src/admin/setup-tools.js");
    for (const section of s.setupListSections()) expect(() => s.setupReadSection(section)).not.toThrow();
    expect(() => s.setupReadSection("toString")).toThrow("unknown setup section");
    expect(() => s.setupReadSection("__proto__")).toThrow("unknown setup section");
  });
});
