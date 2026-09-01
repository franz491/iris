import { beforeEach, describe, expect, it } from "vitest";
import { declaresOversizedJson, probeJsonBody } from "../src/api/json-limits.js";
import { guestChatLimiter, resetGuestChatLimiter } from "../src/api/guest-chat-limiter.js";
import { modelAdmission, resetModelAdmission } from "../src/api/model-admission.js";
import { resetUploadLimiter, uploadLimiter } from "../src/api/upload-limiter.js";

/** A small deterministic corpus is intentional: this is reproducible evidence, not a timing fuzz test. */
function* seededValues(seed = 0x1a15): Generator<number> {
  let state = seed >>> 0;
  while (true) {
    state = (1664525 * state + 1013904223) >>> 0;
    yield state;
  }
}

function corpusString(index: number): string {
  const atoms = ["", "%", "%ZZ", "%E0%A4%A", "a\u0000b", "a\u001fb", "é", "🙂", ".", "..", "/"];
  const atom = atoms[index % atoms.length]!;
  return index % 3 === 0 ? atom.repeat((index % 8) + 1) : atom;
}

describe("bounded input and limiter property corpus", () => {
  beforeEach(() => {
    resetUploadLimiter();
    resetGuestChatLimiter();
    resetModelAdmission();
  });

  it("keeps URL decoding and duplicate detection deterministic for malformed/control/unicode corpus values", () => {
    const random = seededValues(0x1a15);
    const values = Array.from({ length: 96 }, (_, index) => corpusString((random.next().value as number) + index));
    for (const value of values) {
      const encoded = encodeURIComponent(value);
      expect(() => new URL(`https://iris.test/resource?value=${encoded}&value=${encoded}`)).not.toThrow();
      const params = new URLSearchParams(`value=${encoded}&value=${encoded}`);
      expect(params.getAll("value")).toHaveLength(2);
      expect(params.getAll("value")[0]).toBe(value);
    }
    const malformedResults = new Map([
      ["%", "%"],
      ["%ZZ", "%ZZ"],
      ["%E0%A4%A", "�%A"],
      ["%F0%80%80%80", "����"],
    ]);
    for (const [malformed, expected] of malformedResults) {
      const params = new URLSearchParams(`value=${malformed}`);
      expect(params.getAll("value")).toHaveLength(1);
      expect(params.get("value")).toBe(expected);
    }
  });

  it("keeps JSON declaration and chunk probes bounded at generated size boundaries", async () => {
    const sizes = [0, 1, 2, 7, 31, 32, 33, 127, 128, 129, 1023, 1024, 1025];
    for (const size of sizes) {
      const limit = 128;
      const request = new Request("https://iris.test", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(size) },
        body: "x".repeat(size),
      });
      expect(declaresOversizedJson(request, limit)).toBe(size > limit);
      const chunked = new Request("https://iris.test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream({
          start(controller) {
            for (let offset = 0; offset < size; offset += 17)
              controller.enqueue(new Uint8Array(Math.min(17, size - offset)));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
      await expect(probeJsonBody(chunked, { limit, deadlineMs: 1_000 })).resolves.toBe(
        size > limit ? "too_large" : "ok",
      );
    }
  });

  it("preserves limiter invariants across a seeded acquire/release sequence", () => {
    const random = seededValues();
    const timestamps = Array.from({ length: 80 }, (_, index) => 1_000 + index);
    for (const now of timestamps) {
      const key = `account:${(random.next().value as number) % 5}`;
      const uploadRetry = uploadLimiter.consume([key], now);
      const guestRetry = guestChatLimiter.consume(key, 20, now);
      expect(uploadRetry === undefined || (Number.isFinite(uploadRetry) && uploadRetry >= 0)).toBe(true);
      expect(guestRetry === undefined || (Number.isFinite(guestRetry) && guestRetry >= 0)).toBe(true);
    }
    const leases = modelAdmission.tryAcquire(["account:property"], 2, 2_000);
    expect(leases).toHaveLength(2);
    expect(modelAdmission.tryAcquire(["account:property"], 1, 2_001)).toBeUndefined();
    leases!.forEach((lease, index) => {
      lease.release();
      lease.release();
      expect(index).toBeLessThan(2);
    });
    expect(modelAdmission.tryAcquire(["account:property"], 1, 2_002)).toBeDefined();
  });
});
