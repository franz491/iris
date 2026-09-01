import { describe, expect, it } from "vitest";
import { indexParticipants } from "../src/lib/participant-index";

describe("participant index performance contract", () => {
  it("keeps large-history lookup work bounded and deterministic", () => {
    const participantCount = 5000;
    const lookupCount = 1000;
    const warmups = 3;
    const iterations = 10;
    const participants = Array.from({ length: participantCount }, (_, i) => ({ id: `p${i}`, name: `name-${i}` }));
    let mapCalls = 0;
    const instrumented = Object.assign([...participants], {
      map<T>(
        callback: (value: (typeof participants)[number], index: number, array: (typeof participants)[]) => T,
      ): T[] {
        mapCalls++;
        return participants.map(callback);
      },
    }) as typeof participants;
    for (let i = 0; i < warmups; i++) indexParticipants(instrumented);
    let lookups = 0;
    let checksum = 0;
    for (let iteration = 0; iteration < iterations; iteration++) {
      const index = indexParticipants(instrumented);
      for (let i = 0; i < lookupCount; i++) {
        checksum += index.get(`p${(i * 37) % participantCount}`)?.name.length ?? 0;
        lookups++;
      }
    }
    expect(checksum).toBeGreaterThan(0);
    expect(mapCalls).toBe(warmups + iterations);
    expect(lookups).toBe(iterations * lookupCount);
    expect({ participantCount, lookupCount, warmups, iterations, mapCalls, lookups }).toEqual({
      participantCount: 5000,
      lookupCount: 1000,
      warmups: 3,
      iterations: 10,
      mapCalls: 13,
      lookups: 10000,
    });
  });
});
