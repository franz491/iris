import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  pinnedFetch,
  responseLengthExceedsLimit,
  resolvePinned,
  setPinnedRequestForTests,
  setPinnedRequestFactoryForTests,
  pinnedFetchStream,
  setPinnedResolverForTests,
} from "../src/net/pinned-http.js";

afterEach(() => {
  setPinnedResolverForTests();
  setPinnedRequestForTests();
  setPinnedRequestFactoryForTests();
});

describe("shared pinned HTTP transport", () => {
  it("validates every DNS answer and blocks private, loopback, mapped, and multicast targets", async () => {
    setPinnedResolverForTests(async (hostname) => {
      if (hostname === "mixed.example")
        return [
          { address: "203.0.113.7", family: 4 },
          { address: "10.0.0.2", family: 4 },
        ];
      if (hostname === "loopback.example") return [{ address: "127.0.0.2", family: 4 }];
      if (hostname === "mapped.example") return [{ address: "::ffff:169.254.169.254", family: 6 }];
      if (hostname === "multicast.example") return [{ address: "ff02::1", family: 6 }];
      return [];
    });
    for (const hostname of [
      "mixed.example",
      "loopback.example",
      "mapped.example",
      "multicast.example",
      "empty.example",
    ]) {
      await expect(resolvePinned(new URL(`http://${hostname}`))).rejects.toThrow(/disallowed/);
    }
  });

  it("allows explicit local services but rejects unsafe URL syntax", async () => {
    await expect(resolvePinned(new URL("http://localhost:8080"))).resolves.toEqual({ address: "127.0.0.1", family: 4 });
    await expect(resolvePinned(new URL("http://127.0.0.2:8080"))).resolves.toEqual({ address: "127.0.0.2", family: 4 });
    await expect(resolvePinned(new URL("http://user:secret@example.com"))).rejects.toThrow(/unsafe/);
    await expect(resolvePinned(new URL("file:///tmp/value"))).rejects.toThrow(/unsafe/);
  });

  it("passes one validated address and the caller's bound to the transport without following redirects", async () => {
    setPinnedResolverForTests(async () => [{ address: "203.0.113.9", family: 4 }]);
    const seen: unknown[] = [];
    setPinnedRequestForTests(async (url, address, _signal, init, maxBytes) => {
      seen.push({ url: url.href, address, method: init.method, maxBytes });
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
    });
    const response = await pinnedFetch(new URL("https://safe.example/models"), { method: "GET" }, 1234);
    expect(response.status).toBe(302);
    expect(seen).toEqual([
      {
        url: "https://safe.example/models",
        address: { address: "203.0.113.9", family: 4 },
        method: "GET",
        maxBytes: 1234,
      },
    ]);
  });

  it("propagates caller cancellation", async () => {
    setPinnedResolverForTests(async () => [{ address: "203.0.113.9", family: 4 }]);
    setPinnedRequestForTests(
      async (_url, _address, signal) =>
        new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const controller = new AbortController();
    const pending = pinnedFetch(new URL("https://safe.example/models"), { signal: controller.signal });
    controller.abort(new Error("caller stopped"));
    await expect(pending).rejects.toThrow(/caller stopped/);
  });

  it("rejects invalid declared lengths and streamed overflow at the native boundary", () => {
    expect(responseLengthExceedsLimit("101", 0, 100)).toBe(true);
    expect(responseLengthExceedsLimit("invalid", 0, 100)).toBe(true);
    expect(responseLengthExceedsLimit("100", 100, 100)).toBe(false);
    expect(responseLengthExceedsLimit(undefined, 101, 100)).toBe(true);
  });

  it("runs native streaming lifecycle through synthetic request/response doubles", async () => {
    setPinnedResolverForTests(async () => [{ address: "203.0.113.8", family: 4 }]);
    let destroyed = false;
    let received: Buffer | undefined;
    setPinnedRequestFactoryForTests((_url, options, callback) => {
      const request = new (class extends EventEmitter {
        destroy(error?: Error) {
          destroyed = true;
          if (error) this.emit("error", error);
          this.emit("close");
          return this;
        }
        end(body?: any) {
          received = Buffer.from(body ?? "");
          const response = Readable.from([Buffer.from("one"), Buffer.from("two")]) as any;
          response.statusCode = 200;
          response.headers = { "content-length": "6" };
          callback(response);
          return this;
        }
      })();
      expect((options.headers as Record<string, string>).host).toContain("safe.example");
      return request as any;
    });
    const response = await pinnedFetchStream(
      new URL("http://safe.example"),
      { method: "POST", headers: [["x-test", "yes"]], body: "payload" },
      10,
    );
    expect(received?.toString()).toBe("payload");
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("one");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("two");
    await reader.cancel();
    expect(destroyed).toBe(false);
  });

  it("supports both node lookup callback shapes used by the native connector", async () => {
    setPinnedResolverForTests(async () => [{ address: "2001:db8::8", family: 6 }]);
    let lookup: ((hostname: string, options: unknown, callback: (...args: any[]) => void) => void) | undefined;
    setPinnedRequestFactoryForTests((_url, options, callback) => {
      lookup = options.lookup as typeof lookup;
      const request = new (class extends EventEmitter {
        end() {
          const response = Readable.from([]) as any;
          response.statusCode = 200;
          response.headers = {};
          callback(response);
          return this;
        }
      })();
      return request as any;
    });

    await pinnedFetchStream(new URL("https://safe.example"));
    expect(lookup).toBeDefined();
    const allResult: any[] = [];
    lookup!("safe.example", { all: true }, (...args) => allResult.push(...args));
    expect(allResult).toEqual([null, [{ address: "2001:db8::8", family: 6 }]]);
    const oneResult: any[] = [];
    lookup!("safe.example", { all: false }, (...args) => oneResult.push(...args));
    expect(oneResult).toEqual([null, "2001:db8::8", 6]);
  });

  it("rejects oversized native bodies before and during streaming", async () => {
    setPinnedResolverForTests(async () => [{ address: "203.0.113.9", family: 4 }]);
    let destroyed = false;
    setPinnedRequestFactoryForTests((_url, _options, callback) => {
      const request = new (class extends EventEmitter {
        destroy(error?: Error) {
          destroyed = true;
          if (error) this.emit("error", error);
          this.emit("close");
          return this;
        }
        end() {
          const response = Readable.from([Buffer.from("12345")]) as any;
          response.statusCode = 200;
          response.headers = { "content-length": "-1" };
          callback(response);
          return this;
        }
      })();
      return request as any;
    });
    await expect(pinnedFetchStream(new URL("http://safe.example"), {}, 4)).rejects.toThrow(/exceeds/);
    expect(destroyed).toBe(true);
  });

  it("errors a non-ending body on caller abort and destroys once", async () => {
    setPinnedResolverForTests(async () => [{ address: "203.0.113.11", family: 4 }]);
    let destroyed = 0;
    setPinnedRequestFactoryForTests((_url, _options, callback) => {
      const request = new (class extends EventEmitter {
        destroy(error?: Error) {
          destroyed++;
          if (error) this.emit("error", error);
          this.emit("close");
          return this;
        }
        end() {
          const response = new Readable({ read() {} }) as any;
          response.statusCode = 200;
          response.headers = {};
          callback(response);
          return this;
        }
      })();
      return request as any;
    });
    const controller = new AbortController();
    const response = await pinnedFetchStream(new URL("http://safe.example"), { signal: controller.signal }, 100, 1000);
    const reader = response.body!.getReader();
    controller.abort(new Error("stop"));
    await expect(reader.read()).rejects.toThrow();
    expect(destroyed).toBe(1);
  });

  it("errors a non-ending body on timeout after headers", async () => {
    setPinnedResolverForTests(async () => [{ address: "203.0.113.13", family: 4 }]);
    let destroyed = 0;
    setPinnedRequestFactoryForTests((_url, _options, callback) => {
      const request = new (class extends EventEmitter {
        destroy(error?: Error) {
          destroyed++;
          if (error) this.emit("error", error);
          this.emit("close");
          return this;
        }
        end() {
          const response = new Readable({ read() {} }) as any;
          response.statusCode = 200;
          response.headers = {};
          callback(response);
          return this;
        }
      })();
      return request as any;
    });
    const response = await pinnedFetchStream(new URL("http://safe.example"), {}, 100, 5);
    await expect(response.body!.getReader().read()).rejects.toThrow(/outbound request timed out/);
    expect(destroyed).toBe(1);
  });

  it("forwards binary request bodies through the native factory", async () => {
    setPinnedResolverForTests(async () => [{ address: "203.0.113.12", family: 4 }]);
    const bodies: Buffer[] = [];
    setPinnedRequestFactoryForTests((_url, _options, callback) => {
      const request = new (class extends EventEmitter {
        destroy() {
          this.emit("close");
          return this;
        }
        end(body?: any) {
          bodies.push(Buffer.from(body));
          const response = Readable.from([]) as any;
          response.statusCode = 200;
          response.headers = {};
          callback(response);
          return this;
        }
      })();
      return request as any;
    });
    await pinnedFetchStream(new URL("http://safe.example"), { body: new Uint8Array([1, 2]) });
    await pinnedFetchStream(new URL("http://safe.example"), { body: new Uint8Array([3, 4]).buffer });
    expect(bodies.map((x) => x.toString("hex"))).toEqual(["0102", "0304"]);
  });

  it("handles post-header abort, timeout, overflow, cancellation, and pause/resume", async () => {
    setPinnedResolverForTests(async () => [{ address: "203.0.113.10", family: 4 }]);
    let destroyed = 0;
    let paused = 0;
    let resumed = 0;
    setPinnedRequestFactoryForTests((_url, _options, callback) => {
      const request = new (class extends EventEmitter {
        destroy(error?: Error) {
          destroyed++;
          if (error) this.emit("error", error);
          this.emit("close");
          return this;
        }
        end() {
          const response = Readable.from([Buffer.from("123456789")]) as any;
          response.statusCode = 200;
          response.headers = {};
          const p = response.pause.bind(response),
            r = response.resume.bind(response);
          response.pause = () => {
            paused++;
            return p();
          };
          response.resume = () => {
            resumed++;
            return r();
          };
          callback(response);
          return this;
        }
      })();
      return request as any;
    });
    const response = await pinnedFetchStream(new URL("http://safe.example"), {}, 4, 1000);
    await expect(response.body!.getReader().read()).rejects.toThrow(/exceeds/);
    expect(destroyed).toBeGreaterThan(0);
    expect(paused).toBeGreaterThan(0);
    expect(resumed).toBeGreaterThan(0);
    setPinnedRequestFactoryForTests((_url, _options, callback) => {
      const request = new (class extends EventEmitter {
        destroy(error?: Error) {
          destroyed++;
          if (error) this.emit("error", error);
          this.emit("close");
          return this;
        }
        end() {
          const response = new Readable({ read() {} }) as any;
          response.statusCode = 200;
          response.headers = {};
          callback(response);
          return this;
        }
      })();
      return request as any;
    });
    const controller = new AbortController();
    const pending = await pinnedFetchStream(new URL("http://safe.example"), { signal: controller.signal }, 100, 1000);
    const pendingReader = pending.body!.getReader();
    controller.abort(new Error("stop"));
    await expect(pendingReader.read()).rejects.toThrow("stop");
    expect(destroyed).toBeGreaterThan(0);
  });
});
