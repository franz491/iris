import { Hono } from "hono";

export const createFetchHandler =
  (authRouter: Hono, mainRouter: Hono): ((req: Request, env?: unknown) => Response | Promise<Response>) =>
  (req, env) => {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return authRouter.fetch(req, env);
    return mainRouter.fetch(req, env);
  };
