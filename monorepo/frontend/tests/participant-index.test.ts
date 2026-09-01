import { describe, expect, it } from "vitest";
import { indexParticipants } from "../src/lib/participant-index";

describe("participant indexing", () => {
  it("indexes each participant once and preserves fallback lookup", () => {
    const participants = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, name: `n${i}` }));
    const index = indexParticipants(participants);
    expect(index.size).toBe(1000);
    expect(index.get("p777")?.name).toBe("n777");
    expect(index.get("missing")?.name ?? "missing").toBe("missing");
  });
});
