import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createFetchHandler } from "../src/http-handler.js";

describe("node HTTP fetch dispatch", () => {
  it.each(["/api/auth", "/api/auth/sign-in"])("preserves adapter env for %s", async (path) => {
    const auth = new Hono();
    const main = new Hono();
    const env = { server: { incoming: { socket: { remoteAddress: "192.0.2.5" } } } };
    auth.all("*", (c) => Response.json({ router: "auth", same: c.env.server === env.server }));
    main.all("*", (c) => Response.json({ router: "main", same: c.env.server === env.server }));
    const response = await createFetchHandler(auth, main)(new Request(`http://localhost${path}`), env);
    expect(await response.json()).toEqual({ router: "auth", same: true });
  });

  it("preserves adapter env for ordinary API paths", async () => {
    const auth = new Hono();
    const main = new Hono();
    const env = { server: { incoming: { socket: { remoteAddress: "198.51.100.8" } } } };
    main.all("*", (c) => Response.json({ router: "main", same: c.env.server === env.server }));
    const response = await createFetchHandler(auth, main)(new Request("http://localhost/api/status"), env);
    expect(await response.json()).toEqual({ router: "main", same: true });
  });
});
