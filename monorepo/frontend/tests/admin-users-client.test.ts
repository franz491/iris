// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { listAdminUsers, deleteAdminUser } from "../src/lib/admin-users-client";

describe("admin users client", () => {
  it("validates users and maps authorization failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ users: [{ id: "1", name: "A", email: "a@x" }] }), { status: 200 }),
      ),
    );
    await expect(listAdminUsers()).resolves.toHaveLength(1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 403 })),
    );
    await expect(listAdminUsers()).rejects.toThrow("authorization");
  });
  it("validates mutation response and forwards abort", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(deleteAdminUser("u1")).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "DELETE" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u, init) => {
        throw init?.signal?.reason ?? new Error("aborted");
      }),
    );
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(listAdminUsers(controller.signal)).rejects.toThrow("stop");
  });
});
