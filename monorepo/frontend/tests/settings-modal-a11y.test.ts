// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { setupSettingsDialog } from "../src/components/SettingsModal.svelte";

describe("SettingsModal dialog accessibility", () => {
  it("moves focus in, closes on Escape, and restores the trigger", async () => {
    const trigger = document.createElement("button");
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    document.body.append(trigger, dialog);
    trigger.focus();
    let closed = 0;
    const cleanup = setupSettingsDialog(dialog, () => {
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
