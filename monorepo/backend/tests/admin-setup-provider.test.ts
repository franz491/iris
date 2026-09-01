import { describe, expect, it } from "vitest";
import { isAuthorizedAdminSetupChat } from "../src/providers/installed/admin-setup.js";

describe("admin setup chat authorization", () => {
  const admin = (userId = "admin-1") => (userId === "admin-1" ? true : false);
  const ai = { role: "ai", name: "Iris Setup" };
  const human = { role: "user", userId: "admin-1" };

  it.each([
    ["zero humans", []],
    ["multiple humans", [human, { role: "user", userId: "admin-2" }]],
  ])("rejects %s", (_label, humans) => {
    expect(isAuthorizedAdminSetupChat("Iris guided setup", [ai, ...humans], admin)).toBe(false);
  });

  it("accepts exactly one administrator human", () => {
    expect(isAuthorizedAdminSetupChat("Iris guided setup", [ai, human], admin)).toBe(true);
  });

  it("rejects a non-setup chat or non-administrator human", () => {
    expect(isAuthorizedAdminSetupChat("other", [ai, human], admin)).toBe(false);
    expect(isAuthorizedAdminSetupChat("Iris guided setup", [ai, { ...human, userId: "user-1" }], admin)).toBe(false);
  });
});
