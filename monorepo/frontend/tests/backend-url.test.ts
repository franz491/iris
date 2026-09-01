import { describe, expect, it } from "vitest";
import { resolveRequestBase } from "../src/lib/backend-url";

describe("backend URL resolution", () => {
  it("uses the HTTP loopback proxy for browser pages", () => {
    expect(resolveRequestBase("http://127.0.0.1:3000", "http:", "localhost")).toBe("");
  });

  it("keeps the configured backend for Tauri pages", () => {
    expect(resolveRequestBase("http://127.0.0.1:3000", "tauri:", "localhost")).toBe("http://127.0.0.1:3000");
  });

  it("uses the local backend default for Tauri with no URL configured", () => {
    expect(resolveRequestBase("", "tauri:", "localhost")).toBe("http://127.0.0.1:3000");
  });

  it("keeps empty same-origin resolution for an HTTP browser", () => {
    expect(resolveRequestBase("", "http:", "localhost")).toBe("");
  });
});
