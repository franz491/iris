import type { Hono } from "hono";
import { ValidationError } from "../misc/error.js";
import { parseStrictSingleQuery } from "./api-validation.js";
import { z } from "zod";

const modelsQuerySchema = z.object({ router: z.string().trim().min(1).max(256).default("llamacpp") }).strict();
export const parseModelsQuery = (request: Request): { router: string } =>
  parseStrictSingleQuery(request, modelsQuerySchema, "models");

export interface ModelRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseModelsQuery: (request: Request) => { router: string };
  listModels: (router: string) => Promise<unknown[]>;
  listRouters: () => string[] | Promise<string[]>;
  readSetupSettings: () => { defaultModel: unknown } | Promise<{ defaultModel: unknown }>;
  listAdminUsers: () => Array<{ role: string | null }> | Promise<Array<{ role: string | null }>>;
  errorResponse: (error: unknown) => Response;
}

/** Register read-only model and setup catalog endpoints. */
export function registerModelRoutes(app: Hono, deps: ModelRouteDeps): void {
  app.get("/models", async (c) => {
    try {
      await deps.requireUser(c.req.raw);
      const { router } = deps.parseModelsQuery(c.req.raw);
      if (!(await deps.listRouters()).includes(router)) throw new ValidationError("unknown model router");
      return c.json({ models: await deps.listModels(router) });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.get("/model-routers", async (c) => {
    try {
      await deps.requireUser(c.req.raw);
      return c.json({ routers: await deps.listRouters() });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.get("/setup-info", async (c) => {
    try {
      await deps.requireUser(c.req.raw);
      const { defaultModel } = await deps.readSetupSettings();
      return c.json({ defaultModel, configured: (await deps.listAdminUsers()).some((user) => user.role === "admin") });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
