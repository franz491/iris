import type { Hono } from "hono";
import type { ToolSetting } from "../chat/tools.js";
import { z } from "zod";

export const toolConfigSchema = z
  .object({
    clientId: z.string().min(1).max(256),
    tools: z
      .array(
        z
          .object({
            tool: z.string().min(1).max(256),
            requiresApproval: z.boolean().optional(),
            approvalTimeoutMs: z.number().int().nonnegative().max(300_000).optional(),
            settings: z.record(z.unknown()).optional(),
          })
          .strict(),
      )
      .max(256)
      .default([]),
    promptOverrides: z.record(z.string().max(100_000)).optional(),
    loadedTools: z.array(z.string().min(1).max(256)).max(256).optional(),
  })
  .strict();
export const toolResponseSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    clientId: z.string().min(1).max(256),
    approved: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(10_000).optional(),
  })
  .strict();

export interface ToolConfigRouteBody {
  clientId: string;
  tools?: ToolSetting[];
  promptOverrides?: Record<string, string>;
  loadedTools?: string[];
}

export interface ToolResponseRouteBody {
  requestId: string;
  clientId: string;
  approved: boolean;
  result?: unknown;
  error?: string;
}

export interface ToolControlRouteDeps {
  parseChatId: (value: string) => string;
  requireChatMember: (request: Request, chatId: string) => Promise<{ userId: string }>;
  parseToolConfig: (body: unknown) => ToolConfigRouteBody;
  parseToolResponse: (body: unknown) => ToolResponseRouteBody;
  getChat: (chatId: string) => Promise<{
    setToolConfig: (
      userId: string,
      clientId: string,
      config: { tools: ToolSetting[]; promptOverrides?: Record<string, string> },
    ) => void;
    setLoadedGroups: (groups: string[]) => Promise<unknown>;
    effectiveToolConfig: () => { tools: ToolSetting[] };
    loadedGroups: () => string[];
    resolveToolRequest: (
      requestId: string,
      owner: { userId: string; clientId: string },
      response: { approved: boolean; result?: unknown; error?: string },
    ) => boolean;
  }>;
  errorResponse: (error: unknown) => Response;
}

/** Register chat-scoped frontend-tool configuration and response endpoints. */
export function registerToolControlRoutes(app: Hono, deps: ToolControlRouteDeps): void {
  app.patch("/chats/:chatId/tool-config", async (c) => {
    try {
      const chatId = deps.parseChatId(c.req.param("chatId"));
      const { userId } = await deps.requireChatMember(c.req.raw, chatId);
      const body = deps.parseToolConfig(await c.req.json().catch(() => undefined));
      const chat = await deps.getChat(chatId);
      chat.setToolConfig(userId, body.clientId, {
        tools: body.tools ?? [],
        promptOverrides: body.promptOverrides,
      });
      if (body.loadedTools) await chat.setLoadedGroups(body.loadedTools);
      return c.json({ ok: true, active: chat.effectiveToolConfig().tools.length, loaded: chat.loadedGroups() });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.post("/chats/:chatId/tool-response", async (c) => {
    try {
      const chatId = deps.parseChatId(c.req.param("chatId"));
      const { userId } = await deps.requireChatMember(c.req.raw, chatId);
      const body = deps.parseToolResponse(await c.req.json().catch(() => undefined));
      const chat = await deps.getChat(chatId);
      const ok = chat.resolveToolRequest(
        body.requestId,
        { userId, clientId: body.clientId },
        { approved: body.approved, result: body.result, error: body.error },
      );
      if (!ok) return deps.errorResponse(new Error("no such pending request (expired?)"));
      return c.json({ ok: true });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
