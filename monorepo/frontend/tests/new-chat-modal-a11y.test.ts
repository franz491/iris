// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { selectionAriaPressed, setupNewChatDialog } from "../src/components/NewChatModal.svelte";

describe("NewChatModal dialog accessibility", () => {
  it("exposes selected AI cards as pressed toggle buttons", () => {
    expect(selectionAriaPressed(false)).toBe(false);
    expect(selectionAriaPressed(true)).toBe(true);
  });
  it("focuses the dialog, closes on Escape, and restores the opener", async () => {
    const trigger = document.createElement("button");
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    document.body.append(trigger, dialog);
    trigger.focus();
    let closed = 0;
    const cleanup = setupNewChatDialog(dialog, () => {
      closed += 1;
    });
    await Promise.resolve();
    expect(document.activeElement).toBe(dialog);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closed).toBe(1);
    cleanup();
    expect(document.activeElement).toBe(trigger);
  });
  it("cycles Tab focus within the dialog", async () => {
    const dialog = document.createElement("div");
    const first = document.createElement("button"),
      last = document.createElement("button");
    dialog.append(first, last);
    document.body.append(dialog);
    first.focus();
    const cleanup = setupNewChatDialog(dialog, () => undefined);
    await Promise.resolve();
    last.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(first);
    cleanup();
    dialog.remove();
  });
  it("skips disabled and hidden controls and wraps backward from outside focus", async () => {
    const dialog = document.createElement("div");
    const hidden = document.createElement("button"),
      visible = document.createElement("button"),
      outside = document.createElement("button");
    hidden.className = "hidden";
    hidden.disabled = true;
    dialog.append(hidden, visible);
    document.body.append(dialog, outside);
    outside.focus();
    const cleanup = setupNewChatDialog(dialog, () => undefined);
    await Promise.resolve();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true }));
    expect(document.activeElement).toBe(visible);
    cleanup();
    dialog.remove();
    outside.remove();
  });
});
