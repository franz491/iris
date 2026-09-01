import type { Hono } from "hono";
import { UnauthorizedError, ValidationError } from "../misc/error.js";
import { z } from "zod";

interface TransientAudioItem {
  chatId: string;
  bytes: Buffer;
  mimeType: string;
}

const audioHandleQuerySchema = z.object({ chatId: z.string().min(1).max(256) }).strict();

export function parseAudioHandleQuery(request: Request): string {
  const params = new URL(request.url).searchParams;
  const entries = [...params.entries()];
  const chatIds = params.getAll("chatId");
  if (entries.some(([key]) => key !== "chatId") || chatIds.length !== 1) {
    throw new ValidationError("invalid audio handle query", {
      formErrors: ["exactly one chatId query parameter is required"],
      fieldErrors: {},
    });
  }
  const result = audioHandleQuerySchema.safeParse({ chatId: chatIds[0] });
  if (!result.success) throw new ValidationError("invalid audio handle query", result.error.flatten());
  return result.data.chatId;
}

export interface AudioHandleRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseToken: (value: string) => string;
  parseChatQuery: (request: Request) => string;
  getTransientAudio: (token: string) => TransientAudioItem | null;
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  readBoundedBody: (request: Request, maxBytes: number) => Promise<Buffer>;
  maxAudioBytes: () => number;
  validateWavUpload: (bytes: Buffer, contentType: string) => string;
  registerTransientAudio: (chatId: string, bytes: Buffer, mimeType: string) => string;
  errorResponse: (error: unknown) => Response;
}

/** Register ephemeral generated-audio fetch and upload-handle routes. */
export function registerAudioHandleRoutes(app: Hono, deps: AudioHandleRouteDeps): void {
  app.get("/audio/:token", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const token = deps.parseToken(c.req.param("token"));
      const item = deps.getTransientAudio(token);
      if (!item) return c.json({ error: "not_found", message: "audio expired" }, 404);
      if (!(await deps.isUserAuthorizedInChat(item.chatId, userId))) throw new UnauthorizedError("not in this chat");
      return new Response(new Uint8Array(item.bytes), {
        headers: { "content-type": item.mimeType, "cache-control": "no-store" },
      });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });

  app.post("/audio-handles", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatQuery(c.req.raw);
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) throw new UnauthorizedError("not in this chat");
      const bytes = await deps.readBoundedBody(c.req.raw, deps.maxAudioBytes());
      const mimeType = deps.validateWavUpload(bytes, c.req.header("content-type") ?? "");
      return c.json({ audioHandle: deps.registerTransientAudio(chatId, bytes, mimeType) }, 201);
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
