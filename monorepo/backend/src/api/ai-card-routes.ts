import type { Hono } from "hono";
import { z } from "zod";
import { readRuntimeLimits } from "../config/runtime-limits.js";
import { ValidationError } from "../misc/error.js";
import type { AiCard, AiCardInput } from "../chat/database.js";

export interface AiCardRouteDeps {
  requireRegistered: (request: Request) => Promise<{ userId: string }>;
  parseRouteId: (value: string, label: string) => string;
  listAiCards: (userId: string) => Promise<AiCard[]>;
  createAiCard: (userId: string, input: AiCardInput) => Promise<AiCard>;
  updateAiCard: (userId: string, id: string, patch: Partial<AiCardInput>) => Promise<AiCard | null>;
  deleteAiCard: (userId: string, id: string) => Promise<boolean>;
  propagateCard: (
    id: string,
    patch: Pick<AiCard, "name" | "model" | "apiRouter" | "maxContext" | "prompt">,
  ) => Promise<number>;
  listRouters: () => string[] | Promise<string[]>;
  modelContextWindow: (router: string, model: string) => Promise<number | undefined>;
  errorResponse: (error: unknown) => Response;
}

const aiCardFields = {
  name: z.string().trim().min(1).max(256).optional(),
  model: z.string().trim().min(1).max(512).optional(),
  apiRouter: z.string().trim().min(1).max(128).optional(),
  maxContext: z.number().int().positive().max(1_000_000).optional(),
  prompt: z.string().max(1_000_000).optional(),
  avatarSeed: z.string().max(256).optional(),
};

const createAiCardSchema = z
  .object(aiCardFields)
  .extend({ name: z.string().trim().min(1).max(256) })
  .strict();
const updateAiCardSchema = z
  .object({
    ...aiCardFields,
    avatar: z
      .string()
      .max(readRuntimeLimits().avatarBytes)
      .nullable()
      .optional()
      .refine(
        (value) => value === undefined || value === null || value.startsWith("data:image/"),
        "avatar must be an image data URI",
      ),
    propagate: z.boolean().optional(),
  })
  .strict();

/** Register the registered-user AI-card catalog and mutation endpoints. */
export function registerAiCardRoutes(app: Hono, deps: AiCardRouteDeps): void {
  app.get("/ai-cards", async (c) => {
    try {
      const { userId } = await deps.requireRegistered(c.req.raw);
      return c.json({ cards: await deps.listAiCards(userId) });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.post("/ai-cards", async (c) => {
    try {
      const { userId } = await deps.requireRegistered(c.req.raw);
      const bodyResult = createAiCardSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!bodyResult.success) throw new ValidationError("invalid AI card payload", bodyResult.error.flatten());
      const body = bodyResult.data;
      const apiRouter = body.apiRouter ?? "llamacpp";
      if (!(await deps.listRouters()).includes(apiRouter))
        return deps.errorResponse(new Error(`unknown API router ${apiRouter}`));
      const model = body.model ?? "default";
      const discovered = await deps.modelContextWindow(apiRouter, model);
      const card = await deps.createAiCard(userId, {
        name: body.name.trim(),
        model,
        apiRouter,
        maxContext:
          discovered ?? (Number.isSafeInteger(body.maxContext) && body.maxContext! > 0 ? body.maxContext : 8192),
        prompt: body.prompt,
        avatarSeed: body.avatarSeed,
      });
      return c.json(card, 201);
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.patch("/ai-cards/:id", async (c) => {
    try {
      const { userId } = await deps.requireRegistered(c.req.raw);
      const bodyResult = updateAiCardSchema.safeParse(await c.req.json().catch(() => undefined));
      if (!bodyResult.success) throw new ValidationError("invalid AI card payload", bodyResult.error.flatten());
      const body = bodyResult.data;
      if (body.apiRouter !== undefined && !(await deps.listRouters()).includes(body.apiRouter))
        return deps.errorResponse(new Error(`unknown API router ${body.apiRouter}`));
      const card = await deps.updateAiCard(userId, deps.parseRouteId(c.req.param("id"), "AI card id"), {
        ...body,
        avatar: body.avatar ?? undefined,
      });
      if (!card) return deps.errorResponse(new Error("card not found"));
      if (body.propagate === true) {
        const propagatedTo = await deps.propagateCard(card.id, {
          name: body.name ?? card.name,
          model: body.model ?? card.model,
          apiRouter: body.apiRouter ?? card.apiRouter,
          maxContext: body.maxContext ?? card.maxContext,
          prompt: body.prompt ?? card.prompt,
        });
        return c.json({ ...card, propagatedTo });
      }
      return c.json(card);
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.delete("/ai-cards/:id", async (c) => {
    try {
      const { userId } = await deps.requireRegistered(c.req.raw);
      const ok = await deps.deleteAiCard(userId, deps.parseRouteId(c.req.param("id"), "AI card id"));
      if (!ok) return deps.errorResponse(new Error("card not found"));
      return c.json({ ok: true });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
