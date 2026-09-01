import type { Hono } from "hono";
import type { CacheLimits, PlaybackMetadata } from "../admin/audio-cache.js";
import { UnauthorizedError } from "../misc/error.js";
import { parseStrictSingleQuery } from "./api-validation.js";
import { z } from "zod";

const audioCacheQuerySchema = z.object({ chatId: z.string().min(1).max(256) }).strict();
export const parseAudioCacheQuery = (request: Request): string =>
  parseStrictSingleQuery(request, audioCacheQuerySchema, "audio cache").chatId;

export interface AudioCacheRouteDeps {
  requireUser: (request: Request) => Promise<{ userId: string }>;
  parseChatQuery: (request: Request) => string;
  parseCacheId: (value: string) => string;
  isUserAuthorizedInChat: (chatId: string, userId: string) => Promise<boolean>;
  readCacheConfig: () => CacheLimits & { enabled: boolean };
  readCachedAudio: (id: string, limits: CacheLimits, chatId: string) => { bytes: Buffer; mimeType: string } | null;
  getPlaybackMetadata: (id: string, chatId: string) => PlaybackMetadata | null;
  regeneratePlayback: (id: string, metadata: PlaybackMetadata, limits: CacheLimits) => Promise<boolean>;
  errorResponse: (error: unknown) => Response;
}

/** Register private cached-audio replay with bounded regeneration. */
export function registerAudioCacheRoutes(app: Hono, deps: AudioCacheRouteDeps): void {
  app.get("/audio-cache/:id", async (c) => {
    try {
      const { userId } = await deps.requireUser(c.req.raw);
      const chatId = deps.parseChatQuery(c.req.raw);
      if (!(await deps.isUserAuthorizedInChat(chatId, userId))) {
        throw new UnauthorizedError("not in this chat");
      }
      const id = deps.parseCacheId(c.req.param("id"));
      const limits = deps.readCacheConfig();
      if (!limits.enabled) return c.json({ error: "cache_disabled" }, 404);
      let item = deps.readCachedAudio(id, limits, chatId);
      if (!item) {
        const metadata = deps.getPlaybackMetadata(id, chatId);
        if (!metadata?.text) return c.json({ error: "not_found" }, 404);
        const generated = await deps.regeneratePlayback(id, metadata, limits);
        if (!generated) return c.json({ error: "regeneration_failed" }, 502);
        item = deps.readCachedAudio(id, limits, chatId);
      }
      if (!item) return c.json({ error: "not_found" }, 404);
      return new Response(new Uint8Array(item.bytes), {
        headers: { "content-type": item.mimeType, "cache-control": "private, max-age=0" },
      });
    } catch (error) {
      return deps.errorResponse(error);
    }
  });
}
