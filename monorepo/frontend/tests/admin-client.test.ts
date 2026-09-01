// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from "vitest";
import { adminRequest, parseAdminPatch, parseAdminStatus, getAdminStatus } from "../src/lib/admin-client";

const status = { version: 1, config: {}, checklist: [{ group: "server", state: "ok" }] };
const patch = { id: "p1", status: "pending", redactedDiff: { _approvals: { required: ["admin"] } } };

afterEach(() => vi.restoreAllMocks());

describe("typed admin client", () => {
  it("parses valid status and patch responses", () => {
    expect(parseAdminStatus(status)).toMatchObject({ version: 1, checklist: status.checklist });
    expect(parseAdminPatch(patch)).toMatchObject({ id: "p1", status: "pending" });
  });

  it("rejects malformed status and patch responses", () => {
    expect(() => parseAdminStatus({ ...status, checklist: [{ group: "x" }] })).toThrow(
      "Admin status response was invalid",
    );
    expect(() => parseAdminPatch({ id: 4 })).toThrow("Admin patch response was invalid");
    expect(() => parseAdminPatch({ id: "p1", redactedDiff: { _approvals: { required: [1] } } })).toThrow(
      "Admin patch response was invalid",
    );
  });

  it("preserves server HTTP error messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Nope" }), { status: 422 })),
    );
    await expect(adminRequest("/status")).rejects.toThrow("Nope");
  });

  it("prompts once and retries once for recent auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "recent_auth_required" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const prompt = vi.fn(async () => true);
    await expect(getAdminStatus(prompt)).resolves.toMatchObject({ version: 1 });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry when reauth is cancelled, or after a second auth failure", async () => {
    const cancelledFetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "recent_auth_required" }), { status: 401 }),
    );
    vi.stubGlobal("fetch", cancelledFetch);
    const cancel = vi.fn(async () => false);
    await expect(adminRequest("/status", {}, cancel)).rejects.toMatchObject({ code: "recent_auth_required" });
    expect(cancelledFetch).toHaveBeenCalledTimes(1);

    const repeatedFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "recent_auth_required" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "recent_auth_required" }), { status: 401 }));
    vi.stubGlobal("fetch", repeatedFetch);
    const prompt = vi.fn(async () => true);
    await expect(adminRequest("/status", {}, prompt)).rejects.toMatchObject({ code: "recent_auth_required" });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(repeatedFetch).toHaveBeenCalledTimes(2);
  });
});
