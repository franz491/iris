import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerAiCardRoutes, type AiCardRouteDeps } from "../src/api/ai-card-routes.js";
import type { AiCard } from "../src/chat/database.js";

const card = {
  id: "card-1",
  name: "helper",
  model: "model-1",
  apiRouter: "llamacpp",
  maxContext: 8192,
  prompt: "be useful",
} as AiCard;

function setup(overrides: Partial<AiCardRouteDeps> = {}) {
  const app = new Hono();
  const calls: string[] = [];
  const deps: AiCardRouteDeps = {
    requireRegistered: async () => {
      calls.push("auth");
      return { userId: "user-1" };
    },
    parseRouteId: (value) => value,
    listAiCards: async () => {
      calls.push("list");
      return [card];
    },
    createAiCard: async () => {
      calls.push("create");
      return card;
    },
    updateAiCard: async () => {
      calls.push("update");
      return card;
    },
    deleteAiCard: async () => {
      calls.push("delete");
      return true;
    },
    propagateCard: async () => {
      calls.push("propagate");
      return 2;
    },
    listRouters: () => {
      calls.push("routers");
      return ["llamacpp"];
    },
    modelContextWindow: async () => {
      calls.push("context");
      return undefined;
    },
    errorResponse: vi.fn(() => new Response("error", { status: 400 })),
    ...overrides,
  };
  registerAiCardRoutes(app, deps);
  return { app, calls, deps };
}

describe("AI-card route module", () => {
  it("preserves CRUD response shapes and ordering", async () => {
    const { app, calls } = setup();
    expect(await (await app.request("/ai-cards")).json()).toEqual({ cards: [card] });
    expect(calls).toEqual(["auth", "list"]);
    calls.length = 0;

    expect((await app.request("/ai-cards", { method: "POST", body: JSON.stringify({ name: "helper" }) })).status).toBe(
      201,
    );
    expect(calls).toEqual(["auth", "routers", "context", "create"]);
    calls.length = 0;

    expect(
      (await app.request("/ai-cards/card-1", { method: "PATCH", body: JSON.stringify({ name: "new" }) })).status,
    ).toBe(200);
    expect(calls).toEqual(["auth", "update"]);
    calls.length = 0;

    expect((await app.request("/ai-cards/card-1", { method: "DELETE" })).status).toBe(200);
    expect(calls).toEqual(["auth", "delete"]);
  });

  it("rejects malformed payloads before provider or persistence work", async () => {
    const create = vi.fn(async () => card);
    const { app, calls } = setup({ createAiCard: create });
    const response = await app.request("/ai-cards", {
      method: "POST",
      body: JSON.stringify({ name: "helper", unexpected: true }),
    });
    expect(response.status).toBe(400);
    expect(calls).toEqual(["auth"]);
    expect(create).not.toHaveBeenCalled();
  });

  it("supports propagation only after a successful update", async () => {
    const { app, calls } = setup();
    const response = await app.request("/ai-cards/card-1", {
      method: "PATCH",
      body: JSON.stringify({ propagate: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "card-1", propagatedTo: 2 });
    expect(calls).toEqual(["auth", "update", "propagate"]);
  });
});
