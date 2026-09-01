import { afterEach, describe, expect, it } from "vitest";

import { activeSseCount, closeAllSse, registerSse } from "../src/api/sse-owner.js";

afterEach(() => closeAllSse());

describe("SSE fanout performance contract", () => {
  it("drains a fixed client population exactly once", () => {
    const clients = 1000;
    let closeCalls = 0;
    const unregister = Array.from({ length: clients }, () =>
      registerSse(() => {
        closeCalls++;
      }),
    );
    expect(activeSseCount()).toBe(clients);
    closeAllSse();
    expect(closeCalls).toBe(clients);
    expect(activeSseCount()).toBe(0);
    closeAllSse();
    expect(closeCalls).toBe(clients);
    expect(unregister).toHaveLength(clients);
  });
});
