import { describe, expect, it, vi, afterEach } from "vitest";
import { BackendLifecycle } from "../src/lib/backend-lifecycle";

afterEach(() => vi.useRealTimers());
const response = (ok: boolean) => vi.fn(async () => new Response(null, { status: ok ? 200 : 503 }));

describe("BackendLifecycle", () => {
  it("unavailable startup becomes offline and reconnects", async () => {
    vi.useFakeTimers();
    const lifecycle = new BackendLifecycle(response(false) as unknown as typeof fetch);
    await lifecycle.probe("/api/models");
    expect(lifecycle.status).toBe("offline");
    lifecycle.retry("/api/models");
    expect(lifecycle.status).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    await vi.runAllTimersAsync();
    expect(lifecycle.status).toBe("offline");
  });
  it("recovers to ready", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const lifecycle = new BackendLifecycle(f as unknown as typeof fetch);
    await lifecycle.probe("old");
    await lifecycle.probe("new");
    expect(lifecycle.status).toBe("ready");
  });
  it("discards stale probe after cancellation", async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const lifecycle = new BackendLifecycle(vi.fn(() => pending) as unknown as typeof fetch);
    const old = lifecycle.probe("old");
    lifecycle.cancel();
    resolve(new Response(null, { status: 200 }));
    await old;
    expect(lifecycle.status).toBe("starting");
  });
  it("teardown cancels retry timer", () => {
    vi.useFakeTimers();
    const lifecycle = new BackendLifecycle(response(true) as unknown as typeof fetch);
    lifecycle.retry("/api/models");
    lifecycle.cancel();
    vi.advanceTimersByTime(10_000);
    expect(lifecycle.status).toBe("reconnecting");
  });
});
