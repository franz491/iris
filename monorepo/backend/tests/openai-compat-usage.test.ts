import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

afterEach(async () => {
  vi.unstubAllGlobals();
  const net = await import("../src/net/pinned-http.js");
  net.setPinnedResolverForTests();
  net.setPinnedRequestForTests();
});

async function stubPinnedModels(body: unknown): Promise<void> {
  const net = await import("../src/net/pinned-http.js");
  net.setPinnedResolverForTests(async () => [{ address: "203.0.113.9", family: 4 }]);
  net.setPinnedRequestForTests(async () => Response.json(body));
}

async function stubPinnedJson(body: unknown) {
  const net = await import("../src/net/pinned-http.js");
  net.setPinnedResolverForTests(async () => [{ address: "203.0.113.9", family: 4 }]);
  const request = vi.fn(async () => Response.json(body));
  net.setPinnedRequestForTests(request);
  return request;
}

async function stubPinnedStream(body: string | Uint8Array) {
  const net = await import("../src/net/pinned-http.js");
  net.setPinnedResolverForTests(async () => [{ address: "203.0.113.9", family: 4 }]);
  net.setPinnedRequestFactoryForTests((_url, _options, callback) => {
    const req = new (class extends EventEmitter {
      destroy(error?: Error) {
        if (error) this.emit("error", error);
        this.emit("close");
        return this;
      }
      end() {
        const res = Readable.from([Buffer.from(body)]);
        (res as any).statusCode = 200;
        (res as any).headers = { "content-type": "text/event-stream" };
        callback(res as any);
        return this;
      }
    })();
    return req as any;
  });
}

async function stubDeferredStream() {
  const net = await import("../src/net/pinned-http.js");
  net.setPinnedResolverForTests(async () => [{ address: "203.0.113.9", family: 4 }]);
  let destroys = 0;
  net.setPinnedRequestFactoryForTests((_url, _options, callback) => {
    const req = new (class extends EventEmitter {
      destroy(error?: Error) {
        destroys++;
        if (error) this.emit("error", error);
        this.emit("close");
        return this;
      }
      end() {
        const res = Readable.from(
          (async function* () {
            await new Promise<void>(() => undefined);
          })(),
        );
        (res as any).statusCode = 200;
        (res as any).headers = { "content-type": "text/event-stream" };
        callback(res as any);
        return this;
      }
    })();
    return req as any;
  });
  return { destroys: () => destroys };
}

async function stubOneThenDeferredStream() {
  const net = await import("../src/net/pinned-http.js");
  net.setPinnedResolverForTests(async () => [{ address: "203.0.113.9", family: 4 }]);
  let destroys = 0;
  net.setPinnedRequestFactoryForTests((_url, _options, callback) => {
    const req = new (class extends EventEmitter {
      destroy(error?: Error) {
        destroys++;
        if (error) this.emit("error", error);
        this.emit("close");
        return this;
      }
      end() {
        const res = Readable.from(
          (async function* () {
            yield Buffer.from('data: {"choices":[{"delta":{"content":"first"}}]}\n');
            await new Promise<void>(() => undefined);
          })(),
        );
        (res as any).statusCode = 200;
        (res as any).headers = { "content-type": "text/event-stream" };
        callback(res as any);
        return this;
      }
    })();
    return req as any;
  });
  return { destroys: () => destroys };
}

describe("OpenAI-compatible usage", () => {
  it("normalizes every event in a mixed chunk without loss", async () => {
    const { normalizeStreamChunk } = await import("../src/model-router/openai-compat.js");
    const events = normalizeStreamChunk({
      choices: [
        {
          delta: {
            content: "c",
            reasoning_content: "r",
            tool_calls: [
              { index: 1, id: "a", function: { name: "f", arguments: "{" } },
              { index: 2, function: { arguments: "}" } },
            ],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(events.map((event) => event.kind)).toEqual(["delta", "tool_call", "tool_call", "usage", "finish"]);
    expect(events[1]).toMatchObject({ index: 1, id: "a", name: "f", arguments: "{" });
    expect(events[2]).toMatchObject({ index: 2, arguments: "}" });
  });
  it("uses the router base URL when the request override is malformed", async () => {
    const requestMock = await stubPinnedJson({ choices: [{ message: { content: "hello" } }] });
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const router = new OpenAiCompatRouter(() => "http://example.test/v1/");

    await router.completeOnce({
      model: "model",
      context: [{ role: "user", content: "hi" }],
      stream: false,
      additionalFields: { _baseUrl: { unexpected: true } } as never,
    });

    expect(requestMock.mock.calls[0]?.[0].href).toBe("http://example.test/v1/chat/completions");
    expect(requestMock.mock.calls[0]?.[3]).toEqual(expect.objectContaining({ method: "POST" }));
  });

  it("handles malformed additional fields without throwing", async () => {
    await stubPinnedJson({ choices: [{ message: { content: "hello" } }] });
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const router = new OpenAiCompatRouter(() => "http://example.test/v1");

    await expect(
      router.completeOnce({
        model: "model",
        context: [{ role: "user", content: "hi" }],
        stream: false,
        additionalFields: null as never,
      }),
    ).resolves.toMatchObject({ content: "hello" });
  });

  it("rejects an oversized streaming response and cancels the reader", async () => {
    await stubPinnedStream(new Uint8Array(8 * 1024 * 1024 + 1));

    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const router = new OpenAiCompatRouter(() => "http://example.test/v1");
    await expect(async () => {
      for await (const _chunk of router.complete({
        model: "model",
        context: [{ role: "user", content: "hi" }],
        stream: true,
        additionalFields: {},
      })) {
        // consume the stream
      }
    }).rejects.toThrow(/exceeds limit|stream exceeded/);
  });

  it("propagates caller abort before an in-flight stream yields", async () => {
    await stubPinnedStream('data: {"choices":[{"delta":{"content":"late"}}]}\n');
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const router = new OpenAiCompatRouter(() => "http://example.test/v1");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(async () => {
      for await (const _chunk of router.complete({
        model: "model",
        context: [{ role: "user", content: "hi" }],
        stream: true,
        additionalFields: {},
        signal: controller.signal,
      })) {
        /* no events expected */
      }
    }).rejects.toThrow();
  });

  it.each([
    ["timeout", async () => ({ timeoutMs: 10 })],
    [
      "abort",
      async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error("cancelled")), 10);
        return { signal: controller.signal };
      },
    ],
  ])("cancels a deferred reader exactly once on %s", async (_kind, options) => {
    const state = await stubDeferredStream();
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const request = {
      model: "model",
      context: [{ role: "user", content: "hi" }],
      stream: true,
      additionalFields: {},
      ...(await options()),
    };
    await expect(async () => {
      for await (const _chunk of new OpenAiCompatRouter(() => "http://example.test/v1").complete(request)) {
        // no events expected
      }
    }).rejects.toThrow();
    expect(state.destroys()).toBe(1);
  });

  it("cancels the underlying reader when the consumer returns during backpressure", async () => {
    const state = await stubOneThenDeferredStream();
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const iterator = new OpenAiCompatRouter(() => "http://example.test/v1")
      .complete({ model: "model", context: [{ role: "user", content: "hi" }], stream: true, additionalFields: {} })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { delta: "first" }, done: false });
    const pending = iterator.next();
    await iterator.return?.();
    await expect(
      Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 50))]),
    ).resolves.toMatchObject({ done: true });
    expect(state.destroys()).toBe(1);
  });

  it("rejects an oversized unterminated SSE line", async () => {
    const oversized = "data: " + "x".repeat(256 * 1024);
    await stubPinnedStream(oversized);
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const router = new OpenAiCompatRouter(() => "http://example.test/v1");
    await expect(async () => {
      for await (const _chunk of router.complete({
        model: "model",
        context: [{ role: "user", content: "hi" }],
        stream: true,
        additionalFields: {},
      })) {
        // consume the stream
      }
    }).rejects.toThrow("SSE line exceeded");
  });

  it("emits prompt token usage from the final usage-only SSE chunk", async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":314,"completion_tokens":7,"total_tokens":321}}',
      "data: [DONE]",
      "",
    ].join("\n");
    await stubPinnedStream(sse);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const router = new OpenAiCompatRouter(() => "http://example.test/v1");
    const chunks = [];
    for await (const chunk of router.complete({
      model: "model",
      context: [{ role: "user", content: "hi" }],
      stream: true,
      additionalFields: {},
    }))
      chunks.push(chunk);

    expect(
      chunks
        .map((chunk) => chunk.delta)
        .filter(Boolean)
        .join(""),
    ).toBe("hello");
    expect(chunks.at(-1)?.usage).toEqual({
      promptTokens: 314,
      completionTokens: 7,
      totalTokens: 321,
    });
  });

  it("ignores malformed streaming chunk shapes without disrupting valid chunks", async () => {
    const sse = [
      'data: {"choices":{"delta":{"content":"bad"}}}',
      'data: {"choices":[{"delta":null}]}',
      'data: {"choices":[],"usage":"bad"}',
      'data: {"choices":[{"delta":{"content":"hello"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}',
      "data: [DONE]",
      "",
    ].join("\n");
    await stubPinnedStream(sse);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const chunks = [];
    for await (const chunk of new OpenAiCompatRouter(() => "http://example.test/v1").complete({
      model: "model",
      context: [{ role: "user", content: "hi" }],
      stream: true,
      additionalFields: {},
    }))
      chunks.push(chunk);

    expect(chunks.map((chunk) => chunk.delta).filter(Boolean)).toEqual(["hello"]);
    expect(chunks.at(-1)?.usage?.promptTokens).toBe(9);
  });

  it("reads the same standard usage object from non-streaming responses", async () => {
    await stubPinnedJson({
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    });
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const router = new OpenAiCompatRouter(() => "http://example.test/v1");
    const result = await router.completeOnce({
      model: "model",
      context: [{ role: "user", content: "hi" }],
      stream: false,
      additionalFields: {},
    });
    expect(result.usage?.promptTokens).toBe(12);
  });

  it("fails closed on malformed non-streaming provider responses", async () => {
    await stubPinnedJson({ choices: [{ message: { content: 42 } }] });
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    await expect(
      new OpenAiCompatRouter(() => "http://example.test/v1").completeOnce({
        model: "model",
        context: [{ role: "user", content: "hi" }],
        stream: false,
        additionalFields: {},
      }),
    ).rejects.toThrow("invalid response");
  });

  it("keeps literal, split, and malformed think tags visible while using explicit reasoning", async () => {
    const { normalizeReasoning } = await import("../src/model-router/openai-compat.js");
    expect(normalizeReasoning("<think>literal</think>", undefined)).toEqual({ content: "<think>literal</think>" });
    expect(normalizeReasoning("<think>split", undefined)).toEqual({ content: "<think>split" });
    expect(normalizeReasoning("visible", "private reasoning")).toEqual({
      content: "visible",
      thought: "private reasoning",
    });
    expect(normalizeReasoning("<think>unterminated", "explicit")).toEqual({
      content: "<think>unterminated",
      thought: "explicit",
    });
  });
});

describe("model metadata routing", () => {
  it("reads llama.cpp meta.n_ctx only through the llama.cpp router", async () => {
    await stubPinnedModels({
      data: [{ id: "gemma-vision", meta: { n_ctx: 131072 } }],
    });
    const { LlamaCppRouter } = await import("../src/model-router/llamacpp.js");
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    const llama = new LlamaCppRouter(() => "http://example.test/v1");
    const generic = new OpenAiCompatRouter(() => "http://example.test/v1");

    expect(await llama.listModels()).toEqual([{ id: "gemma-vision", contextWindow: 131072 }]);
    expect(await generic.listModels()).toEqual([{ id: "gemma-vision" }]);
  });

  it("drops malformed model entries instead of leaking unchecked provider JSON", async () => {
    await stubPinnedModels({
      data: [{ id: "valid/model:v2" }, { id: 42 }, null, { id: "" }, { id: "bad\nmodel" }, { id: "x".repeat(513) }],
    });
    const { OpenAiCompatRouter } = await import("../src/model-router/openai-compat.js");
    expect(await new OpenAiCompatRouter(() => "http://example.test/v1").listModels()).toEqual([
      { id: "valid/model:v2" },
    ]);
  });

  it("ignores invalid llama.cpp context metadata", async () => {
    await stubPinnedModels({
      data: [{ id: "model", meta: { n_ctx: "unknown" } }],
    });
    const { LlamaCppRouter } = await import("../src/model-router/llamacpp.js");
    expect(await new LlamaCppRouter(() => "http://example.test/v1").listModels()).toEqual([
      { id: "model", contextWindow: undefined },
    ]);
  });

  it("reads context size from llama.cpp preset-router model listings", async () => {
    await stubPinnedModels({
      data: [
        { id: "Qwen-fast", status: { args: ["llama", "serve", "--ctx-size", "64000"] } },
        { id: "gemma-vision", status: { preset: "jinja = true\nctx-size = 128000\nmodel = gemma.gguf\n" } },
      ],
    });
    const { LlamaCppRouter } = await import("../src/model-router/llamacpp.js");
    expect(await new LlamaCppRouter(() => "http://example.test/v1").listModels()).toEqual([
      { id: "Qwen-fast", contextWindow: 64000 },
      { id: "gemma-vision", contextWindow: 128000 },
    ]);
  });
});
