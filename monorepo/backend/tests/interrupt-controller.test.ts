import { describe, expect, it } from "vitest";
import { InterruptController } from "../src/chat/interrupt-controller.js";

describe("interrupt controller", () => {
  it("owns revision invalidation and cancels active generations", () => {
    const controller = new InterruptController();
    const generation = controller.start("ai-1")!;
    expect(controller.historyRevision()).toBe(0);
    expect(controller.participants()).toEqual(["ai-1"]);
    expect(controller.rewriteHistory()).toBe(1);
    expect(generation.signal.aborted).toBe(true);
    expect(controller.participants()).toEqual([]);
  });

  it("preserves stop versus interrupt completion semantics", () => {
    const controller = new InterruptController();
    controller.start("ai-stop");
    expect(controller.request("ai-stop", "stop")).toBe(true);
    expect(controller.complete("ai-stop")).toEqual({ restart: false, stopRequested: true });

    controller.start("ai-restart");
    expect(controller.request("ai-restart", "interrupt")).toBe(true);
    expect(controller.complete("ai-restart")).toEqual({ restart: true, stopRequested: false });
  });

  it("delegates duplicate starts, cancellation, and all cancellation safely", () => {
    const controller = new InterruptController();
    expect(controller.start("ai-1")).toBeDefined();
    expect(controller.start("ai-1")).toBeUndefined();
    expect(controller.request("missing", "stop")).toBe(false);
    controller.cancel("ai-1");
    expect(controller.participants()).toEqual([]);
    controller.start("ai-1");
    controller.start("ai-2");
    controller.cancelAll();
    expect(controller.participants()).toEqual([]);
    expect(controller.complete("ai-1")).toEqual({ restart: false, stopRequested: false });
  });

  it("keeps revisions monotonic across repeated rewrites", () => {
    const controller = new InterruptController();
    expect(controller.rewriteHistory()).toBe(1);
    expect(controller.rewriteHistory()).toBe(2);
    expect(controller.historyRevision()).toBe(2);
  });
});
