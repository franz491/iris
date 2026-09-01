import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("roadmap disposition contract", () => {
  it("disposes every roadmap item with a reviewable criterion", () => {
    const root = path.resolve(process.cwd(), "..");
    const roadmap = readFileSync(path.join(root, "roadmap.txt"), "utf8");
    const disposition = readFileSync(path.join(root, "docs/roadmap-disposition.md"), "utf8");
    const items = [
      "Admin production hardening",
      "Runtime resource policies",
      "Managed runtime/model downloads",
      "Audio platform coverage",
      "ComfyUI workflow UX",
      "CLI API migration",
      "Prompt quality",
      "Thinking-tag handling",
      "Default model onboarding",
      "Hono router workaround",
      "Tauri packaging",
      "Search provider",
      "Multi-device profile sync",
    ];
    expect(items.every((item) => roadmap.includes(item))).toBe(true);
    for (const item of items) {
      const row = disposition.split("\n").find((line) => line.startsWith(`| ${item}`));
      expect(row, `missing disposition for ${item}`).toBeTruthy();
      expect(row).toMatch(/\|\s+(deliver|redesign|defer)\s+\|/);
      expect(row).toMatch(/review \d{4}-\d{2}-\d{2}/);
    }
    expect(disposition).toContain("No roadmap item is a production-readiness claim.");
  });
});
