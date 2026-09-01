import { beforeEach, describe, expect, it, vi } from "vitest";
import { FrontendToolWaitRegistry } from "../src/chat/frontend-tool-wait.js";
import { metricsSnapshot, resetMetrics } from "../src/misc/metrics.js";

describe("frontend tool wait registry", () => {
  beforeEach(resetMetrics);

  it("resolves only for the selected client and cleans the wait exactly once", async () => {
    const controller = new AbortController();
    const registry = new FrontendToolWaitRegistry(() => "request-1");
    let emitted = "";
    const pending = registry.wait({
      userId: "user-1",
      clientId: "client-1",
      timeoutMs: 100,
      signal: controller.signal,
      emit: (requestId) => (emitted = requestId),
    });
    expect(emitted).toBe("request-1");
    expect(registry.resolve("request-1", { userId: "user-2", clientId: "client-1" }, { approved: true })).toBe(false);
    expect(registry.resolve("request-1", { userId: "user-1", clientId: "client-1" }, { approved: true })).toBe(true);
    expect(await pending.promise).toEqual({ approved: true });
    expect(registry.resolve("request-1", { userId: "user-1", clientId: "client-1" }, { approved: true })).toBe(false);
    expect(registry.size).toBe(0);
    expect(metricsSnapshot().requests).toMatchObject({ "tool_waits.started": 1, "tool_waits.completed": 1 });
  });

  it("does not overwrite a live wait when the request-id source repeats", async () => {
    const controller = new AbortController();
    const registry = new FrontendToolWaitRegistry(() => "same-request");
    const first = registry.wait({
      userId: "user-1",
      clientId: "client-1",
      timeoutMs: 100,
      signal: controller.signal,
      emit: () => undefined,
    });
    const second = registry.wait({
      userId: "user-2",
      clientId: "client-2",
      timeoutMs: 100,
      signal: new AbortController().signal,
      emit: () => {
        throw new Error("must not emit a colliding request");
      },
    });
    await expect(second.promise).resolves.toEqual({
      approved: false,
      error: "could not allocate a unique tool request id",
    });
    expect(registry.size).toBe(1);
    expect(registry.resolve("same-request", { userId: "user-1", clientId: "client-1" }, { approved: true })).toBe(true);
    await expect(first.promise).resolves.toEqual({ approved: true });
  });

  it("uses exactly sixteen allocator attempts before failing closed", async () => {
    const controller = new AbortController();
    const createRequestId = vi.fn(() => "same-request");
    const registry = new FrontendToolWaitRegistry(createRequestId);
    const first = registry.wait({
      userId: "user-1",
      clientId: "client-1",
      timeoutMs: 100,
      signal: controller.signal,
      emit: () => undefined,
    });
    const second = registry.wait({
      userId: "user-2",
      clientId: "client-2",
      timeoutMs: 100,
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    await expect(second.promise).resolves.toMatchObject({ approved: false });
    expect(createRequestId).toHaveBeenCalledTimes(17);
    registry.cancelAll();
    await first.promise;
  });

  it("gives abort precedence over timeout and does not emit an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const registry = new FrontendToolWaitRegistry(() => "request-2");
    let emitted = false;
    const pending = registry.wait({
      userId: "user-1",
      clientId: "client-1",
      timeoutMs: 5,
      signal: controller.signal,
      emit: () => (emitted = true),
    });
    expect(await pending.promise).toEqual({ approved: false, error: "generation cancelled" });
    expect(emitted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registry.size).toBe(0);
    expect(metricsSnapshot().requests).toMatchObject({ "tool_waits.cancelled": 1 });
    expect(metricsSnapshot().requests["tool_waits.timed_out"]).toBeUndefined();
  });

  it("times out and cancelAll resolves each pending request idempotently", async () => {
    const registry = new FrontendToolWaitRegistry(() => `request-${registry.size + 1}`, {
      onTimeout: () => undefined,
    });
    const first = registry.wait({
      userId: "user-1",
      clientId: "client-1",
      timeoutMs: 5,
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    const second = registry.wait({
      userId: "user-2",
      clientId: "client-2",
      timeoutMs: 0,
      signal: new AbortController().signal,
      emit: () => undefined,
    });
    expect(await first.promise).toEqual({ approved: false, error: "timed out after 5ms" });
    registry.cancelAll("shutdown");
    registry.cancelAll("shutdown-again");
    expect(await second.promise).toEqual({ approved: false, error: "shutdown" });
    expect(registry.size).toBe(0);
    expect(metricsSnapshot().requests).toMatchObject({
      "tool_waits.started": 2,
      "tool_waits.timed_out": 1,
      "tool_waits.cancelled": 1,
    });
  });

  it("resolves the timeout even when the observability hook throws", async () => {
    const registry = new FrontendToolWaitRegistry(() => "request-hook-error", {
      onTimeout: () => {
        throw new Error("sink unavailable");
      },
    });
    const pending = registry.wait({
      userId: "user-1",
      clientId: "client-1",
      timeoutMs: 1,
      signal: new AbortController().signal,
      emit: () => undefined,
    });

    await expect(pending.promise).resolves.toEqual({ approved: false, error: "timed out after 1ms" });
    expect(registry.size).toBe(0);
    expect(metricsSnapshot().requests).toMatchObject({
      "tool_waits.started": 1,
      "tool_waits.timed_out": 1,
    });
  });
});
