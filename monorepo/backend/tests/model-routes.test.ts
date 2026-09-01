import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerModelRoutes } from "../src/api/model-routes.js";

function setup(router = "llamacpp") {
  const app = new Hono();
  const calls: string[] = [];
  const errorResponse = vi.fn(() => new Response("error", { status: 400 }));
  registerModelRoutes(app, {
    requireUser: async () => {
      calls.push("auth");
      return { userId: "user-1" };
    },
    parseModelsQuery: () => {
      calls.push("parse");
      return { router };
    },
    listModels: async () => {
      calls.push("models");
      return [{ id: "model-1" }];
    },
    listRouters: () => {
      calls.push("routers");
      return ["llamacpp"];
    },
    readSetupSettings: () => {
      calls.push("setup");
      return { defaultModel: { model: "model-1" } };
    },
    listAdminUsers: () => {
      calls.push("admins");
      return [{ role: "admin" }];
    },
    errorResponse,
  });
  return { app, calls, errorResponse };
}

describe("model/setup route module", () => {
  it("preserves response shapes and dependency ordering", async () => {
    const { app, calls } = setup();
    expect(await (await app.request("/models")).json()).toEqual({ models: [{ id: "model-1" }] });
    expect(calls).toEqual(["auth", "parse", "routers", "models"]);
    calls.length = 0;
    expect(await (await app.request("/model-routers")).json()).toEqual({ routers: ["llamacpp"] });
    expect(calls).toEqual(["auth", "routers"]);
    calls.length = 0;
    expect(await (await app.request("/setup-info")).json()).toEqual({
      defaultModel: { model: "model-1" },
      configured: true,
    });
    expect(calls).toEqual(["auth", "setup", "admins"]);
  });

  it("does not list models for an unknown router", async () => {
    const { app, errorResponse, calls } = setup("missing-router");
    const response = await app.request("/models");
    expect(response.status).toBe(400);
    expect(errorResponse).toHaveBeenCalledOnce();
    expect(calls).toEqual(["auth", "parse", "routers"]);
  });

  it("fails closed before downstream work when authentication rejects", async () => {
    const app = new Hono();
    const parse = vi.fn(() => ({ router: "llamacpp" }));
    const list = vi.fn(() => ["llamacpp"]);
    const errorResponse = vi.fn(() => new Response("denied", { status: 401 }));
    registerModelRoutes(app, {
      requireUser: async () => {
        throw new Error("denied");
      },
      parseModelsQuery: parse,
      listModels: async () => [],
      listRouters: list,
      readSetupSettings: () => ({ defaultModel: {} }),
      listAdminUsers: () => [],
      errorResponse,
    });
    expect((await app.request("/models")).status).toBe(401);
    expect(parse).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});
