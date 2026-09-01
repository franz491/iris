import { describe, expect, it, vi } from "vitest";
import { recoverBeforeProjection } from "../src/runtime/reconcile-startup.js";

describe("startup reconciliation ordering", () => {
  it("recovers before projecting", async () => {
    const events: string[] = [];
    await recoverBeforeProjection(
      async () => {
        events.push("recover");
      },
      async () => {
        events.push("project");
      },
    );
    expect(events).toEqual(["recover", "project"]);
  });

  it("does not project when recovery fails", async () => {
    const project = vi.fn(async () => undefined);
    await expect(
      recoverBeforeProjection(async () => {
        throw new Error("recovery failed");
      }, project),
    ).rejects.toThrow("recovery failed");
    expect(project).not.toHaveBeenCalled();
  });
});
