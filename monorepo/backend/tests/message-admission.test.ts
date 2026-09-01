import { describe, expect, it } from "vitest";
import { reserveMessageAdmission } from "../src/api/message-admission.js";

describe("message admission boundary", () => {
  it("does not reserve for broadcasts with no AI targets", () => {
    let called = false;
    expect(
      reserveMessageAdmission({ userId: "u", targetCount: 0, tryAcquire: () => ((called = true), undefined) }),
    ).toEqual([]);
    expect(called).toBe(false);
  });

  it("uses account and optional source keys with target count as slots", () => {
    let captured: { keys: readonly string[]; slots: number } | undefined;
    const lease = { release: () => undefined };
    expect(
      reserveMessageAdmission({
        userId: "u",
        source: "source",
        targetCount: 2,
        tryAcquire: (keys, slots) => {
          captured = { keys, slots };
          return [lease, lease];
        },
      }),
    ).toEqual([lease, lease]);
    expect(captured).toEqual({ keys: ["account:u", "source:source"], slots: 2 });
  });

  it("passes through rejection without changing admission ownership", () => {
    expect(reserveMessageAdmission({ userId: "u", targetCount: 1, tryAcquire: () => undefined })).toBeUndefined();
  });
});
