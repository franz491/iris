import { describe, expect, it } from "vitest";
import { GenerationCoordinator } from "../src/chat/generation-coordinator.js";

describe("generation coordinator", () => {
  it("allows one generation per participant and cleans up idempotently", () => {
    const coordinator = new GenerationCoordinator();
    const first = coordinator.start("ai-1");
    expect(first?.generationId).toBe(1);
    expect(coordinator.start("ai-1")).toBeUndefined();
    expect(coordinator.participants()).toEqual(["ai-1"]);
    expect(coordinator.complete("ai-1")).toEqual({ restart: false, stopRequested: false });
    expect(coordinator.complete("ai-1")).toEqual({ restart: false, stopRequested: false });
    expect(coordinator.participants()).toEqual([]);
  });

  it("allows only one owner when sends race for the same AI", () => {
    const coordinator = new GenerationCoordinator();
    const starts = [coordinator.start("ai-1"), coordinator.start("ai-1")];
    expect(starts.filter(Boolean)).toHaveLength(1);
    expect(coordinator.participants()).toEqual(["ai-1"]);
  });

  it.each([
    ["interrupt", true, false],
    ["stop", false, true],
  ] as const)("records %s intent and aborts its generation", (intent, restart, stopRequested) => {
    const coordinator = new GenerationCoordinator();
    const generation = coordinator.start("ai-1");
    expect(generation).toBeDefined();
    expect(coordinator.request("ai-1", intent)).toBe(true);
    expect(generation?.signal.aborted).toBe(true);
    expect(coordinator.complete("ai-1")).toEqual({ restart, stopRequested });
  });

  it("keeps an explicit stop from being overwritten by a concurrent interrupt", () => {
    const coordinator = new GenerationCoordinator();
    const generation = coordinator.start("ai-1");
    expect(coordinator.request("ai-1", "stop")).toBe(true);
    expect(coordinator.request("ai-1", "interrupt")).toBe(true);
    expect(generation?.signal.aborted).toBe(true);
    expect(coordinator.complete("ai-1")).toEqual({ restart: false, stopRequested: true });
  });

  it("exposes an aborted signal for cancellation-aware observers", () => {
    const coordinator = new GenerationCoordinator();
    const generation = coordinator.start("ai-1");
    expect(generation?.signal.aborted).toBe(false);
    coordinator.request("ai-1", "stop");
    expect(generation?.signal.aborted).toBe(true);
    expect(generation?.isStopRequested()).toBe(true);
  });

  it("cancels all participants without retaining ownership", () => {
    const coordinator = new GenerationCoordinator();
    const first = coordinator.start("ai-1");
    const second = coordinator.start("ai-2");
    coordinator.cancelAll();
    expect(first?.signal.aborted).toBe(true);
    expect(second?.signal.aborted).toBe(true);
    expect(coordinator.participants()).toEqual([]);
    expect(coordinator.request("ai-1", "interrupt")).toBe(false);
  });
});
