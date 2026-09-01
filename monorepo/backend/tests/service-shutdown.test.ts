import { describe, expect, it } from "vitest";
import { ownedProcessMayStop } from "../src/admin/services.js";
describe("owned service shutdown decision", () => {
  it("stops only matching live identities", () => {
    expect(ownedProcessMayStop("a", "a")).toBe(true);
    expect(ownedProcessMayStop("a", "b")).toBe(false);
    expect(ownedProcessMayStop("a", null)).toBe(false);
  });
});
