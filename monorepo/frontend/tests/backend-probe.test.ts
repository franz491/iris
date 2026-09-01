import { describe, it, expect } from "vitest";
import { probeBackend } from "../src/lib/backend-probe";

function fakeFetch(status: number | "reject"): typeof fetch {
  return (async () => {
    if (status === "reject") throw new TypeError("network down");
    return { ok: status >= 200 && status < 300, status } as Response;
  }) as unknown as typeof fetch;
}

describe("probeBackend", () => {
  it("online only when the backend answers ok", async () => {
    expect(await probeBackend(fakeFetch(200))).toBe(true);
    expect(await probeBackend(fakeFetch(204))).toBe(true);
  });

  it("offline when the proxy answers with an error status", async () => {
    // vite dev proxy replies 502/504 when the backend is down — fetch resolves!
    expect(await probeBackend(fakeFetch(502))).toBe(false);
    expect(await probeBackend(fakeFetch(404))).toBe(false);
    expect(await probeBackend(fakeFetch(500))).toBe(false);
  });

  it("offline on network rejection or timeout", async () => {
    expect(await probeBackend(fakeFetch("reject"))).toBe(false);
  });
});
