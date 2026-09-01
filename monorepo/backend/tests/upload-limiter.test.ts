import { beforeEach, describe, expect, it } from "vitest";
import {
  resetUploadLimiter,
  UPLOAD_LIMIT_PER_WINDOW,
  uploadLimiter,
  uploadRateLimitResponse,
  uploadSource,
  registerTrustedSource,
} from "../src/api/upload-limiter.js";

describe("upload abuse limiter", () => {
  beforeEach(() => resetUploadLimiter());

  it("limits account and source atomically and reports retry metadata", async () => {
    for (let i = 0; i < UPLOAD_LIMIT_PER_WINDOW; i++) {
      expect(uploadLimiter.consume(["account:u", "source:1"], 1_000 + i)).toBeUndefined();
    }
    expect(uploadLimiter.consume(["account:u", "source:1"], 2_000)).toBeGreaterThan(0);
    expect(uploadLimiter.consume(["account:other", "source:1"], 2_000)).toBeGreaterThan(0);
    expect(await uploadRateLimitResponse(12).json()).toEqual({
      error: "rate_limited",
      message: "Too many uploads; try again later.",
    });
    expect(uploadRateLimitResponse(12).headers.get("retry-after")).toBe("12");
  });

  it("expires entries and supports deterministic reset", () => {
    for (let i = 0; i < UPLOAD_LIMIT_PER_WINDOW; i++) uploadLimiter.consume(["account:u"], 1_000);
    expect(uploadLimiter.consume(["account:u"], 1_001)).toBeGreaterThan(0);
    expect(uploadLimiter.consume(["account:u"], 61_000)).toBeUndefined();
    for (let i = 0; i < UPLOAD_LIMIT_PER_WINDOW; i++) uploadLimiter.consume(["account:u"], 62_000);
    resetUploadLimiter();
    expect(uploadLimiter.consume(["account:u"], 62_001)).toBeUndefined();
  });

  it("does not use forwarded client headers as a source key", () => {
    const request = new Request("http://localhost", { headers: { "x-forwarded-for": "spoofed" } });
    expect(uploadSource(request)).toBeUndefined();
    const adapted = new Request("http://localhost", { headers: { "x-iris-remote-address": " 10.0.0.1 " } });
    registerTrustedSource(adapted, " 10.0.0.1 ");
    expect(uploadSource(adapted)).toBe("10.0.0.1");
  });

  it("ignores malformed or oversized adapter source values", () => {
    const control = new Request("http://localhost", { headers: { "x-iris-remote-address": "10.0.0.1\u007f" } });
    const oversized = new Request("http://localhost", { headers: { "x-iris-remote-address": "x".repeat(256) } });
    expect(uploadSource(control)).toBeUndefined();
    expect(uploadSource(oversized)).toBeUndefined();
  });

  it("admits exactly one winner per key at a concurrent boundary", () => {
    const results = Array.from({ length: UPLOAD_LIMIT_PER_WINDOW + 2 }, (_, i) =>
      uploadLimiter.consume(["account:u"], 1_000 + i),
    );
    expect(results.filter((result) => result === undefined)).toHaveLength(UPLOAD_LIMIT_PER_WINDOW);
    expect(results.slice(-2).every((result) => typeof result === "number")).toBe(true);
  });
});
