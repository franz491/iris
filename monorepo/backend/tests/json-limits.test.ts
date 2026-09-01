import { describe, expect, it } from "vitest";
import {
  DEFAULT_JSON_BODY_TIMEOUT_MS,
  declaresOversizedJson,
  isJsonContentType,
  MAX_JSON_BODY_BYTES,
  jsonBodyTimeoutMs,
  probeJsonBody,
  streamedJsonExceedsLimit,
} from "../src/api/json-limits.js";

describe("JSON request limits", () => {
  it("recognizes JSON media types and rejects only declared oversize JSON", () => {
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
    expect(isJsonContentType("application/problem+json")).toBe(true);
    expect(isJsonContentType("audio/wav")).toBe(false);
    expect(
      declaresOversizedJson(
        new Request("http://iris.test", {
          headers: { "content-type": "application/json", "content-length": String(MAX_JSON_BODY_BYTES + 1) },
        }),
      ),
    ).toBe(true);
    expect(
      declaresOversizedJson(
        new Request("http://iris.test", {
          headers: { "content-type": "application/json", "content-length": String(MAX_JSON_BODY_BYTES) },
        }),
      ),
    ).toBe(false);
  });

  it("rejects oversized chunked JSON without a content-length header", async () => {
    const body = "{" + '"value":"' + "x".repeat(MAX_JSON_BODY_BYTES) + '"}';
    const request = new Request("http://iris.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    await expect(streamedJsonExceedsLimit(request)).resolves.toBe(true);
  });

  it("allows chunked JSON at or below the limit", async () => {
    const request = new Request("http://iris.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });

    await expect(streamedJsonExceedsLimit(request)).resolves.toBe(false);
    await expect(request.json()).resolves.toEqual({ value: "x" });
  });

  it("keeps the original body parseable after probing a chunked request", async () => {
    const request = new Request("http://iris.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "preserved" }),
    });
    await expect(probeJsonBody(request)).resolves.toBe("ok");
    await expect(request.json()).resolves.toEqual({ value: "preserved" });
  });

  it("does not throw when called after the request body was consumed", async () => {
    const request = new Request("http://iris.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consumed: true }),
    });
    await request.text();
    await expect(probeJsonBody(request)).resolves.toBe("ok");
  });

  it("reports overflow and cancels the cloned reader", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
      },
    });
    const request = new Request("http://iris.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    await expect(probeJsonBody(request, { limit: 2 })).resolves.toBe("too_large");
  });

  it("times out a slow chunk and cancels the cloned reader", async () => {
    const body = new ReadableStream({});
    const request = new Request("http://iris.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    await expect(probeJsonBody(request, { deadlineMs: 20 })).resolves.toBe("timeout");
  });

  it("reports client abort and cancels the cloned reader", async () => {
    const controller = new AbortController();
    const body = new ReadableStream({
      start(streamController) {
        streamController.enqueue(new Uint8Array([1]));
      },
    });
    const request = new Request("http://iris.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
      signal: controller.signal,
    } as RequestInit);
    controller.abort();
    await expect(probeJsonBody(request, { deadlineMs: 1_000, signal: controller.signal })).resolves.toBe("aborted");
  });

  it("clamps configured body deadlines to a finite safe range", () => {
    const previous = process.env.IRIS_JSON_BODY_TIMEOUT_MS;
    delete process.env.IRIS_JSON_BODY_TIMEOUT_MS;
    try {
      expect(jsonBodyTimeoutMs(undefined)).toBe(DEFAULT_JSON_BODY_TIMEOUT_MS);
      expect(jsonBodyTimeoutMs("not-a-number")).toBe(DEFAULT_JSON_BODY_TIMEOUT_MS);
      expect(jsonBodyTimeoutMs("0")).toBe(DEFAULT_JSON_BODY_TIMEOUT_MS);
      expect(jsonBodyTimeoutMs("999999999")).toBe(300_000);
      expect(jsonBodyTimeoutMs("12.9")).toBe(12);
    } finally {
      if (previous === undefined) delete process.env.IRIS_JSON_BODY_TIMEOUT_MS;
      else process.env.IRIS_JSON_BODY_TIMEOUT_MS = previous;
    }
  });
});
