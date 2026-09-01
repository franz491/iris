import { describe, expect, it, vi, afterEach } from "vitest";
import { LlamaCppRouter } from "../src/model-router/llamacpp.js";
import { setPinnedRequestForTests } from "../src/net/pinned-http.js";

afterEach(() => {
  vi.unstubAllGlobals();
  setPinnedRequestForTests();
});

const response = (body: unknown, ok = true) =>
  new Response(JSON.stringify(body), { status: ok ? 200 : 500, headers: { "content-type": "application/json" } });

describe("llama.cpp model metadata boundary", () => {
  it("accepts valid entries and caps the catalog", async () => {
    setPinnedRequestForTests(async () =>
      response({ data: Array.from({ length: 300 }, (_, i) => ({ id: `model-${i}` })) }),
    );
    const models = await new LlamaCppRouter(() => "http://127.0.0.1:8080/v1").listModels();
    expect(models).toHaveLength(256);
    expect(models[0].id).toBe("model-0");
    expect(models[255].id).toBe("model-255");
  });

  it("rejects unsafe ids and malformed or oversized nested metadata", async () => {
    setPinnedRequestForTests(async () =>
      response({
        data: [
          { id: "bad\nmodel" },
          { id: "valid", status: { args: ["x".repeat(257)] } },
          { id: "valid2", meta: { n_ctx: { nope: true } } },
          { id: "ok", meta: { n_ctx: 4096 } },
        ],
      }),
    );
    await expect(new LlamaCppRouter(() => "http://127.0.0.1:8080/v1").listModels()).resolves.toEqual([
      { id: "ok", contextWindow: 4096 },
    ]);
  });

  it("fails closed on transport and non-JSON failures", async () => {
    setPinnedRequestForTests(async () => new Response("not json"));
    await expect(new LlamaCppRouter(() => "http://127.0.0.1:8080/v1").listModels()).resolves.toEqual([]);
  });
});
