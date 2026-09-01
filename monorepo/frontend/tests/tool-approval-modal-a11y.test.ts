// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { removeFolderLabel, setupToolApprovalDialog } from "../src/components/ToolApprovalModal.svelte";

describe("ToolApprovalModal dialog accessibility", () => {
  it("uses unique labels for folder removal actions", () => {
    expect([0, 1, 2].map(removeFolderLabel)).toEqual([
      "Remove allowed folder 1",
      "Remove allowed folder 2",
      "Remove allowed folder 3",
    ]);
  });
  it("focuses deny, treats Escape as denial, and restores the opener", async () => {
    const trigger = document.createElement("button");
    const dialog = document.createElement("div");
    const deny = document.createElement("button");
    dialog.append(deny);
    document.body.append(trigger, dialog);
    trigger.focus();
    let denied = 0;
    const cleanup = setupToolApprovalDialog(dialog, () => {
      denied += 1;
    });
    await Promise.resolve();
    expect(document.activeElement).toBe(deny);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(denied).toBe(1);
    cleanup();
    expect(document.activeElement).toBe(trigger);
  });
  it("cycles keyboard focus within the approval dialog", async () => {
    const dialog = document.createElement("div");
    const first = document.createElement("button"),
      last = document.createElement("button");
    dialog.append(first, last);
    document.body.append(dialog);
    first.focus();
    const cleanup = setupToolApprovalDialog(dialog, () => undefined);
    await Promise.resolve();
    last.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(document.activeElement).toBe(first);
    cleanup();
    dialog.remove();
  });
});
