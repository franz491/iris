import type { Hono } from "hono";
import type { ToolGroupDef } from "../chat/tools.js";
import { UnauthorizedError } from "../misc/error.js";
import { parseStrictSingleQuery } from "./api-validation.js";
import { z } from "zod";

const toolsQuerySchema = z.object({ chatId: z.string().max(256).default("") }).strict();
export const parseToolsQuery = (request: Request): { chatId: string } =>
  parseStrictSingleQuery(request, toolsQuerySchema, "tools");

interface ToolDocs {
  tool: string;
  functions: Record<string, string>;
}

export interface ToolRouteDeps {
  resolveViewer: (request: Request) => Promise<{ userId: string }>;
  parseToolsQuery: (request: Request) => { chatId: string };
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  getChat: (chatId: string) => Promise<{ loadedGroups: () => string[] }>;
  loadCatalog: () => Promise<{
    groups: Record<string, ToolGroupDef>;
    alwaysLoadedGroups: readonly string[];
    loadToolDocs: (group: string) => ToolDocs;
    aiGroupName: (group: ToolGroupDef) => string;
  }>;
  errorResponse: (error: unknown) => Response;
}

/** Register the read-only tool catalog, keeping the registry lazy-loaded. */
export function registerToolRoutes(app: Hono, deps: ToolRouteDeps): void {
  app.get("/tools", async (c) => {
    try {
      const { userId } = await deps.resolveViewer(c.req.raw);
      const { chatId } = deps.parseToolsQuery(c.req.raw);
      const catalog = await deps.loadCatalog();
      let loaded: string[] | null = null;
      if (chatId) {
        if (!(await deps.isUserAuthorizedInChat(chatId, userId))) {
          throw new UnauthorizedError("not in this chat");
        }
        loaded = (await deps.getChat(chatId)).loadedGroups();
      }
      const groups = Object.values(catalog.groups).map((group) => {
        const docs = catalog.loadToolDocs(group.name);
        return {
          name: group.name,
          aiName: catalog.aiGroupName(group),
          backend: Boolean(group.backend),
          flavor: group.flavor,
          alwaysLoaded: catalog.alwaysLoadedGroups.includes(group.name),
          editable: group.flavor === "frontend",
          toolDoc: docs.tool || group.functions.map((fn) => fn.description).join(" "),
          functions: Object.fromEntries(
            group.functions.map((fn) => [
              fn.name,
              { doc: docs.functions[fn.name] ?? fn.description, parameters: fn.parameters },
            ]),
          ),
          ...(loaded ? { loaded: loaded.includes(group.name) } : {}),
        };
      });
      return c.json({ groups, ...(loaded ? { loaded } : {}) });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
