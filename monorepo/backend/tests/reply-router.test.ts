import { describe, expect, it } from "vitest";
import {
  audienceForAiMessage,
  mentionedParticipantIds,
  routeReply,
  stripAiNamePrefix,
} from "../src/chat/reply-router.js";
import type { Participant } from "../src/chat/types.js";

const participants = [
  { id: "u1", name: "Alice", role: "user" },
  { id: "u2", name: "Bob", role: "user" },
  { id: "ai1", name: "Bot", role: "ai" },
] as Participant[];

describe("reply router", () => {
  it("routes exact mentions, preserving tags and punctuation", () => {
    expect(routeReply("  hello @BOB. @ghost  ", participants)).toEqual([{ content: "hello @BOB. @ghost", to: ["u2"] }]);
    expect(mentionedParticipantIds("@alice @bob @bob", participants)).toEqual(["u1", "u2"]);
  });

  it("splits only on the explicit new-message marker", () => {
    expect(routeReply("@bob secret<new-message>public\n\ntext", participants)).toEqual([
      { content: "@bob secret", to: ["u2"] },
      { content: "public\n\ntext", to: undefined },
    ]);
  });

  it("suppresses no-reply and whitespace unless forced", () => {
    expect(routeReply(" <NO REPLY> ", participants)).toEqual([]);
    expect(routeReply(" <NO REPLY> ", participants, { forceAiReply: true })).toEqual([
      { content: "<NO REPLY>", to: undefined },
    ]);
    expect(routeReply(" \n ", participants)).toEqual([]);
  });

  it("keeps audience scopes user-only and deterministic", () => {
    expect(audienceForAiMessage(["ai1", "u2", "u1", "u2"], participants)).toEqual(["u1", "u2"]);
    expect(audienceForAiMessage(["ai1"], participants)).toEqual([]);
    expect(audienceForAiMessage(undefined, participants)).toEqual([]);
  });

  it("strips an optional AI name prefix without altering other content", () => {
    expect(stripAiNamePrefix("  b_ot: hello", "b ot")).toBe("hello");
    expect(stripAiNamePrefix("robot: hello", "bot")).toBe("robot: hello");
  });
});
