import { describe, expect, it } from "vitest";
import { discover } from "../src/admin/discovery.js";
describe("admin discovery", () =>
  it("reports host capabilities without mutating the host", () => {
    const r = discover();
    expect(r.os.cpus).toBeGreaterThan(0);
    expect(r.os.memoryBytes).toBeGreaterThan(0);
    expect(Array.isArray(r.executables)).toBe(true);
  }));
