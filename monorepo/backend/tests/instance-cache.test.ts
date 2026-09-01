import { describe, expect, it, vi } from "vitest";
import { InstanceCache } from "../src/chat/instance-cache.js";

type Entry = { name?: string; dispose: (reason?: string) => void };

describe("instance cache", () => {
  it("shares in-flight construction and caches the result", async () => {
    const cache = new InstanceCache<string, Entry>();
    let calls = 0;
    const create = async () => {
      calls++;
      await Promise.resolve();
      return { dispose: () => undefined };
    };

    const [first, second] = await Promise.all([cache.get("chat", create), cache.get("chat", create)]);
    expect(first).toBe(second);
    expect(calls).toBe(1);
    expect(await cache.get("chat", create)).toBe(first);
  });

  it("removes failed construction so retries can run", async () => {
    const cache = new InstanceCache<string, Entry>();
    let calls = 0;
    const create = async () => {
      calls++;
      if (calls === 1) throw new Error("load failed");
      return { dispose: () => undefined };
    };

    await expect(cache.get("chat", create)).rejects.toThrow("load failed");
    const recovered = await cache.get("chat", create);
    expect(recovered).toBeDefined();
    expect(calls).toBe(2);
  });

  it("does not install a result evicted during construction and disposes cached entries", async () => {
    const cache = new InstanceCache<string, Entry>();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let disposed = 0;
    const entry = { dispose: () => disposed++ };
    const loading = cache.get("chat", async () => {
      await gate;
      return entry;
    });
    cache.evict("chat");
    release();
    expect(await loading).toBe(entry);
    expect(disposed).toBe(1);

    let calls = 0;
    const replacement = await cache.get("chat", async () => {
      calls++;
      return { dispose: () => undefined };
    });
    expect(replacement).not.toBe(entry);
    expect(calls).toBe(1);
  });

  it("disposes a replaced instance and does not resurrect its pending result", async () => {
    const cache = new InstanceCache<string, Entry>();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    let oldDisposed = 0;
    let staleDisposed = 0;
    const loading = cache.get("chat", async () => {
      await pending;
      return { dispose: () => staleDisposed++ };
    });
    const replacement = { dispose: () => oldDisposed++ };
    const old = { dispose: () => oldDisposed++ };
    cache.set("other", old);
    cache.set("other", replacement);
    cache.set("chat", replacement);
    release();
    expect(await loading).not.toBe(replacement);
    expect(oldDisposed).toBe(1);
    expect(staleDisposed).toBe(1);
    expect(await cache.get("chat", async () => replacement)).toBe(replacement);
  });

  it("disposes every cached instance without clearing ownership", () => {
    const cache = new InstanceCache<string, Entry>();
    const reasons: string[] = [];
    cache.set("one", { dispose: (reason) => reasons.push(reason ?? "") });
    cache.set("two", { dispose: (reason) => reasons.push(reason ?? "") });
    cache.disposeAll("shutdown");
    expect(reasons).toEqual(["shutdown", "shutdown"]);
  });

  it("evicts the least-recent idle entry and leaves active entries alone", async () => {
    const active = new Set<string>();
    const disposed: string[] = [];
    const cache = new InstanceCache<string, Entry>({
      maxEntries: 2,
      isIdle: (entry) => !entry.name || !active.has(entry.name),
    });
    const make = (name: string) => ({ name, dispose: () => disposed.push(name) });
    cache.set("one", make("one"));
    cache.set("two", make("two"));
    await cache.get("one", async () => make("one")); // one becomes most-recent
    active.add("one");
    cache.set("three", make("three"));
    expect(cache.size).toBe(2);
    expect(disposed).toEqual(["two"]);
    active.delete("one");
    cache.trim();
    expect(cache.size).toBe(2);
  });

  it("temporarily exceeds the bound when every entry is active, then trims on retry", () => {
    let idle = false;
    const cache = new InstanceCache<string, Entry>({ maxEntries: 1, isIdle: () => idle });
    cache.set("one", { dispose: () => undefined });
    cache.set("two", { dispose: () => undefined });
    expect(cache.size).toBe(2);
    idle = true;
    cache.trim();
    expect(cache.size).toBe(1);
  });

  it("does not evict the value returned by a new get", async () => {
    const cache = new InstanceCache<string, Entry>({ maxEntries: 1, isIdle: () => true });
    const first = { dispose: vi.fn() };
    const second = { dispose: vi.fn() };
    cache.set("first", first);
    expect(await cache.get("second", async () => second)).toBe(second);
    expect(second.dispose).not.toHaveBeenCalled();
    expect(first.dispose).toHaveBeenCalledWith("instance cache capacity");
  });

  it("does not evict an explicitly inserted value while trimming", () => {
    const cache = new InstanceCache<string, Entry>({ maxEntries: 1, isIdle: () => true });
    const first = { dispose: vi.fn() };
    const second = { dispose: vi.fn() };
    cache.set("first", first);
    cache.set("second", second);
    expect(cache.size).toBe(1);
    expect(second.dispose).not.toHaveBeenCalled();
    expect(first.dispose).toHaveBeenCalledWith("instance cache capacity");
  });
});
