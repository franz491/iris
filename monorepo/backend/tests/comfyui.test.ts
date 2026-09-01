import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "../src/api/binary-limits.js";
import { MAX_JSON_BODY_BYTES } from "../src/api/json-limits.js";
import { dataFile, openDb } from "../src/db/sqlite.js";
import {
  getHistory,
  getOutput,
  getQueue,
  getSystemStats,
  listWorkflows,
  saveWorkflow,
  submitWorkflow,
  setComfyLookupForTests,
  setComfyRequestForTests,
  type ResolvedAddress,
} from "../src/admin/comfyui.js";

const responseFromChunks = (chunks: Uint8Array[]): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );

describe("ComfyUI adapter", () => {
  it("pins native requests and rejects unsafe DNS answers", async () => {
    const seen: Array<{ url: string; address: ResolvedAddress; maxBytes?: number }> = [];
    setComfyRequestForTests(async (url, address, _signal, _body, maxBytes) => {
      seen.push({ url: url.href, address, maxBytes });
      return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }));
    });
    setComfyLookupForTests(async (host) =>
      host === "safe.example" ? [{ address: "203.0.113.9", family: 4 }] : [{ address: "192.168.1.4", family: 4 }],
    );
    await getQueue({ baseUrl: "http://safe.example" });
    expect(seen[0]).toEqual({
      url: "http://safe.example/queue",
      address: { address: "203.0.113.9", family: 4 },
      maxBytes: MAX_JSON_BODY_BYTES,
    });
    await expect(getQueue({ baseUrl: "http://unsafe.example" })).rejects.toThrow(/disallowed/);
    setComfyLookupForTests();
    setComfyRequestForTests();
  });

  it.each(["http://localhost", "http://127.0.0.1", "http://[::1]"])(
    "allows literal local endpoint %s",
    async (baseUrl) => {
      setComfyRequestForTests(async () => new Response(JSON.stringify({ queue_running: [], queue_pending: [] })));
      await expect(getQueue({ baseUrl })).resolves.toBeDefined();
      setComfyRequestForTests();
    },
  );

  it("rejects mapped IPv6 metadata, multicast, empty, and DNS failures", async () => {
    setComfyLookupForTests(async (host) => {
      if (host === "mapped.example") return [{ address: "::ffff:169.254.169.254", family: 6 }];
      if (host === "multicast.example") return [{ address: "ff02::1", family: 6 }];
      if (host === "empty.example") return [];
      throw new Error("DNS failure");
    });
    for (const host of ["mapped.example", "multicast.example", "empty.example", "failure.example"])
      await expect(getQueue({ baseUrl: `http://${host}` })).rejects.toThrow();
    setComfyLookupForTests();
  });

  it("does not follow redirects and preserves native response bounds", async () => {
    setComfyRequestForTests(
      async () => new Response(null, { status: 302, headers: { location: "http://evil.example" } }),
    );
    await expect(getQueue({ baseUrl: "http://127.0.0.1" })).rejects.toThrow(/ComfyUI 302/);
    setComfyRequestForTests(async () => new Response(new Uint8Array(MAX_JSON_BODY_BYTES + 1)));
    await expect(getQueue({ baseUrl: "http://127.0.0.1" })).rejects.toThrow(/response body exceeds/);
    setComfyRequestForTests();
  });
  it("preserves valid workflow persistence", () => {
    const workflow = { "1": { class_type: "KSampler", inputs: {} } };
    const saved = saveWorkflow("test workflow", workflow, "workflow-1");
    expect(listWorkflows()).toEqual([saved]);
  });

  it("fails closed for malformed persisted workflow rows", () => {
    const sqlite = openDb(dataFile("admin.db")).sqlite;
    sqlite
      .prepare("INSERT INTO admin_comfy_workflows VALUES (?,?,?,?,?)")
      .run("malformed-workflow", "Malformed", "not-json", "created", "updated");
    expect(() => listWorkflows()).toThrow(/malformed ComfyUI workflow row/);
  });

  it("submits workflows through the native prompt API", async () => {
    const calls: Request[] = [];
    const c = {
      baseUrl: "http://comfy.local",
      fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(new Request(input, init));
        return new Response(JSON.stringify({ prompt_id: "p1" }), { status: 200 });
      },
    };
    expect(await submitWorkflow(c, { "1": { class_type: "KSampler", inputs: {} } }, "client")).toEqual({
      promptId: "p1",
    });
    expect(calls[0].url).toBe("http://comfy.local/prompt");
  });

  it("bounds chunked JSON responses", async () => {
    const oversized = new Uint8Array(MAX_JSON_BODY_BYTES + 1);
    const c = { baseUrl: "http://comfy.local", fetchImpl: async () => responseFromChunks([oversized]) };
    await expect(getQueue(c)).rejects.toThrow(/response body exceeds/);
  });

  it("rejects JSON responses that do not match the endpoint shape", async () => {
    const c = {
      baseUrl: "http://comfy.local",
      fetchImpl: async () => new Response(JSON.stringify({ queue_running: [] })),
    };
    await expect(getQueue(c)).rejects.toThrow(/queue response has an invalid shape/);
    await expect(getHistory({ ...c, fetchImpl: async () => new Response(JSON.stringify([])) }, "p1")).rejects.toThrow(
      /history response must be an object/,
    );
  });

  it("rejects malformed prompt responses and unsupported output types", async () => {
    const c = { baseUrl: "http://comfy.local", fetchImpl: async () => new Response(JSON.stringify({ prompt_id: 42 })) };
    await expect(submitWorkflow(c, { "1": { class_type: "KSampler", inputs: {} } })).rejects.toThrow(/prompt_id/);
    await expect(getOutput(c, "image.png", "", "other")).rejects.toThrow(/type is invalid/);
  });

  it("rejects invalid workflow nodes and prompt identifiers before fetching", async () => {
    let called = false;
    const c = {
      baseUrl: "http://comfy.local",
      fetchImpl: async () => {
        called = true;
        return new Response("{}");
      },
    };
    await expect(submitWorkflow(c, { "1": { class_type: "", inputs: {} } })).rejects.toThrow(/invalid node/);
    await expect(getHistory(c, "bad\u0000id")).rejects.toThrow(/prompt id is invalid/);
    expect(called).toBe(false);
  });

  it("bounds serialized workflow request bodies", async () => {
    const workflow = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => [
        String(index),
        {
          class_type: "KSampler",
          inputs: { payload: "x".repeat(200) },
        },
      ]),
    );
    const c = { baseUrl: "http://comfy.local", fetchImpl: async () => new Response("{}") };
    await expect(submitWorkflow(c, workflow)).rejects.toThrow(/request body exceeds/);
  });

  it("aborts requests after the configured timeout", async () => {
    const c = {
      baseUrl: "http://comfy.local",
      timeoutMs: 5,
      fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), {
            once: true,
          });
        }),
    };
    await expect(getSystemStats(c)).rejects.toThrow();
  });

  it("bounds chunked binary output responses", async () => {
    const oversized = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    const c = { baseUrl: "http://comfy.local", fetchImpl: async () => responseFromChunks([oversized]) };
    await expect(getOutput(c, "image.png")).rejects.toThrow(/response body exceeds/);
  });

  it.each([
    ["../image.png", ""],
    ["image.png", "../outputs"],
    ["/absolute.png", ""],
    ["image.png", "/absolute"],
    ["..\\image.png", ""],
    ["image.png", "nested\\output"],
    ["image\u0000.png", ""],
  ])("rejects unsafe output query values (%s, %s)", async (filename, subfolder) => {
    const c = { baseUrl: "http://comfy.local", fetchImpl: async () => new Response("ok") };
    await expect(getOutput(c, filename, subfolder)).rejects.toThrow(/unsafe ComfyUI/);
  });

  it("encodes safe output query values", async () => {
    let requested: URL | undefined;
    const c = {
      baseUrl: "http://comfy.local",
      fetchImpl: async (input: RequestInfo | URL) => {
        requested = new URL(input.toString());
        return new Response("image");
      },
    };
    await getOutput(c, "image 1.png", "renders/2026", "output");
    expect(requested?.searchParams.get("filename")).toBe("image 1.png");
    expect(requested?.searchParams.get("subfolder")).toBe("renders/2026");
  });
});
