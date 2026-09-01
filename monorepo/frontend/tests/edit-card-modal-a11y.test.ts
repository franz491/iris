// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { setupEditCardDialog } from "../src/components/EditCardModal.svelte";

describe("EditCardModal dialog accessibility", () => {
  it("focuses the dialog, closes on Escape, and restores the opener", async () => {
    const trigger = document.createElement("button");
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    document.body.append(trigger, dialog);
    trigger.focus();
    let closed = 0;
    const cleanup = setupEditCardDialog(dialog, () => {
      closed += 1;
    });
    await Promise.resolve();
    expect(document.activeElement).toBe(dialog);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closed).toBe(1);
    cleanup();
    expect(document.activeElement).toBe(trigger);
  });
});
