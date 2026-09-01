import { describe, expect, it } from "vitest";
import { validateProfiles } from "../src/admin/profiles.js";
describe("admin profiles", () =>
  it("rejects broken service and fallback references", () => {
    const c: any = { services: [], profiles: [{ name: "local", service: "missing", fallback: "local" }] };
    expect(validateProfiles(c)).toEqual([
      "profile local references unknown service missing",
      "profile local cannot fall back to itself",
    ]);
  }));
