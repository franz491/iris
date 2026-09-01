import { describe, expect, it } from "vitest";
import { historyWindow } from "../src/lib/history-window";

describe("history window", () => {
  it("keeps small histories and stable ordering intact", () => {
    const messages = ["a", "b", "c"];
    expect(historyWindow(messages, false, 4)).toEqual({ visible: messages, hidden: 0 });
  });

  it("bounds large histories to the newest chunk and expands deterministically", () => {
    const messages = Array.from({ length: 6 }, (_, i) => i);
    expect(historyWindow(messages, false, 3)).toEqual({ visible: [3, 4, 5], hidden: 3 });
    expect(historyWindow(messages, true, 3)).toEqual({ visible: messages, hidden: 0 });
  });

  it("does not hide the active tail when the tail is the recent window", () => {
    const messages = Array.from({ length: 121 }, (_, i) => ({ id: i, active: i === 120 }));
    const result = historyWindow(messages, false, 120);
    expect(result.visible.at(-1)?.active).toBe(true);
    expect(result.hidden).toBe(1);
  });
});
