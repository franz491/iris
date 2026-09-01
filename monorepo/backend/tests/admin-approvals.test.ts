import { describe, expect, it } from "vitest";
import { classifyPatch } from "../src/admin/approvals.js";
describe("admin approvals", () =>
  it("gates network changes without second-guessing administrator-owned commands", () => {
    const a = classifyPatch({
      server: { port: 3001 },
      services: [{ process: { executable: "pkill", arguments: ["example"] }, shutdownPolicy: "terminate-owned" }],
    });
    expect(a.required).toEqual(expect.arrayContaining(["standard", "network"]));
    expect(a.required).not.toEqual(expect.arrayContaining(["executable", "destructive"]));
  }));
