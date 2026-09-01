import { describe, expect, it } from "vitest";
import { activeSseCount, closeAllSse, registerSse } from "../src/api/sse-owner.js";

describe("SSE owner", () => {
  it("closes each client once and removes registrations", () => {
    let calls = 0;
    const unregister = registerSse(() => {
      calls++;
    });
    expect(activeSseCount()).toBe(1);
    closeAllSse();
    closeAllSse();
    expect(calls).toBe(1);
    expect(activeSseCount()).toBe(0);
    unregister();
  });
});
