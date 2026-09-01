import { describe, expect, it } from "vitest";
import { isLoopbackAddress, validateTls } from "../src/admin/security.js";
describe("admin TLS validation", () => {
  it("requires hostname for ACME", () =>
    expect(validateTls({ mode: "acme", trustedOrigins: [] })).toContain("ACME requires a hostname"));
  it("rejects malformed origins", () =>
    expect(validateTls({ mode: "localhost-only", trustedOrigins: ["not-a-url"] })).toContain(
      "trusted origins must be absolute URLs",
    ));
});
describe("bootstrap peer validation", () =>
  it("accepts only IP loopback forms", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.9.10")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.20")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
  }));
