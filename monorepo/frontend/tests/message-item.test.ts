// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { getToolInfos, toolToggleLabel } from "../src/components/MessageItem.svelte";
import type { Message } from "../src/lib/types";

const message = (type: Message["type"], content: string): Message => ({
  id: "message",
  chatId: "chat",
  authorId: "author",
  type,
  thought: "",
  content,
  createdAt: "now",
});

describe("MessageItem tool display parsing", () => {
  it("provides an accessible disclosure label that tracks keyboard activation state", () => {
    const button = document.createElement("button");
    let expanded = false;
    const sync = () => {
      expanded = !expanded;
      button.setAttribute("aria-expanded", String(expanded));
      button.setAttribute("aria-label", toolToggleLabel("search", expanded));
    };
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", toolToggleLabel("search", false));
    button.onclick = sync;
    expect(button.getAttribute("aria-label")).toBe("Expand tool use search");
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Collapse tool use search");
  });
  it("keeps malformed tool-call entries renderable", () => {
    expect(getToolInfos(message("tool", '[null, "not a call", {"name":"ok"}]'))).toEqual([
      { fn: "?", args: {}, result: null, ok: null, playbackId: undefined },
      { fn: "?", args: {}, result: null, ok: null, playbackId: undefined },
      { fn: "ok", args: {}, result: null, ok: null, playbackId: undefined },
    ]);
  });

  it("preserves valid calls and rejects malformed result envelopes safely", () => {
    const call = message("tool", '[{"name":"lookup","arguments":"{\\"q\\":\\"iris\\"}"}]');
    const malformedResult = message("tool_result", "[]");

    expect(getToolInfos(call, [malformedResult])).toEqual([
      {
        fn: "lookup",
        args: { q: "iris" },
        result: "[]",
        ok: true,
        playbackId: undefined,
      },
    ]);
    expect(getToolInfos(message("tool_result", "null"))).toEqual([
      {
        fn: "?",
        args: null,
        result: "null",
        ok: null,
        playbackId: undefined,
      },
    ]);
  });

  it("does not pass oversized or malformed runtime results to rendering", () => {
    const call = message("tool", '[{"name":"lookup"}]');
    const oversizedResult = message("tool_result", `{"result":"${"x".repeat(256 * 1024)}"}`);

    expect(getToolInfos(call, [oversizedResult])).toEqual([
      {
        fn: "lookup",
        args: {},
        result: null,
        ok: true,
        playbackId: undefined,
      },
    ]);

    const malformedRuntimeMessage = message("tool_result", "not json") as Message & { content: unknown };
    malformedRuntimeMessage.content = { result: "unexpected object" };
    expect(getToolInfos(malformedRuntimeMessage)).toEqual([
      {
        fn: "tool_result",
        args: { result: "unexpected object" },
        result: null,
        ok: null,
      },
    ]);
  });
});
