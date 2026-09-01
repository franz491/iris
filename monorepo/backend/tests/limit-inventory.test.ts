import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type Inventory = {
  version: number;
  policy: string;
  runtimePolicy: { variables: Record<string, string> };
  limits: Array<{
    category: string;
    limit: string;
    owner: string;
    enforcement: string;
    tests: string;
    configurability: string;
  }>;
};

describe("IRIS-012 limit inventory", () => {
  it("audits every plan-listed category to an owner, seam, test, and policy", () => {
    const root = path.resolve(process.cwd(), "..");
    const inventory = JSON.parse(
      readFileSync(path.join(root, "docs/operations/limit-inventory.json"), "utf8"),
    ) as Inventory;
    // These are the categories named by the IRIS-012 acceptance inventory.
    // Additional safeguards may be documented without changing this core set.
    const planCategories = [
      "json",
      "avatar/data-uri",
      "file upload/download",
      "audio handle",
      "STT body",
      "streaming chunks",
      "tool arguments/results",
      "prompt/workflow",
      "log retention",
      "concurrent regenerations",
    ];
    expect(inventory.version).toBe(1);
    expect(inventory.policy).toMatch(/configurability is explicit/);
    const categories = inventory.limits.map((entry) => entry.category);
    expect(new Set(categories).size).toBe(categories.length);
    for (const category of planCategories) expect(categories.filter((value) => value === category)).toHaveLength(1);
    expect(inventory.runtimePolicy.variables.builtinPromptCacheEntries).toBe("BUILTIN_PROMPT_CACHE_MAX_ENTRIES");
    for (const entry of inventory.limits) {
      expect(entry.limit.length).toBeGreaterThan(0);
      expect(entry.enforcement.length).toBeGreaterThan(0);
      for (const owner of entry.owner.split("; ")) expect(existsSync(path.join(root, owner))).toBe(true);
      for (const testFile of entry.tests.split("; ")) expect(existsSync(path.join(root, testFile))).toBe(true);
      expect([
        "fixed conservative default",
        "fixed schema bound",
        "fixed policy bound",
        "validated environment override",
      ]).toContain(entry.configurability);
    }
  });
});
