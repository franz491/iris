import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerApiMiddleware } from "../src/api/api-middleware.js";

describe("API middleware", () => {
  it("propagates bounded correlation IDs and records completed responses", async () => {
    const app = new Hono();
    const info = vi.fn();
    const record = vi.fn();
    registerApiMiddleware(app, { accessLog: { info }, recordRequest: record });
    app.get("/ok", (c) => c.json({ ok: true }));

    const response = await app.request("/ok", { headers: { "x-correlation-id": "client-42" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("client-42");
    expect(record).toHaveBeenCalledWith("GET", 200, expect.any(Number));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"requestId":"client-42"'));
  });

  it("fails bounded JSON probes before the handler", async () => {
    const app = new Hono();
    const handler = vi.fn(() => new Response("should not run"));
    registerApiMiddleware(app, {
      probeJsonBody: vi.fn(async () => "too_large"),
      jsonTooLargeResponse: () => new Response("too large", { status: 413 }),
    });
    app.post("/payload", handler);

    expect((await app.request("/payload", { method: "POST" })).status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });
});
