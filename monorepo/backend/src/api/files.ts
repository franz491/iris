// api/files.ts — file download and upload through the frontend.
// Files are stored through the "files" provider's sandbox root via the kernel.
import { Hono } from "hono";
import { createReadStream } from "node:fs";
import { requireChatMember } from "./auth-guards.js";
import { kernel } from "../runtime/kernel.js";
import { toAppError, ValidationError } from "../misc/error.js";
import { getChat } from "../chat/chat.js";
import { decodeBoundedBase64, streamToPrivateTemp } from "./binary-limits.js";
import { eventRecord, logger } from "../misc/logging.js";
import {
  attachmentMessageExists,
  clearAttachmentStage,
  listStagedAttachments,
  stageAttachment,
} from "../chat/database.js";
import { uuid } from "../misc/utils.js";
import { parseProviderContract } from "../providers/contracts.js";
import { uploadLimiter, uploadRateLimitResponse, uploadSource } from "./upload-limiter.js";
import { dataFile } from "../db/sqlite.js";
import { z } from "zod";
import { readRuntimeLimits } from "../config/runtime-limits.js";

export const filesApi = new Hono();
const log = logger("attachments");

async function* streamTempFile(filename: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
  const stream = createReadStream(filename);
  const abort = () => stream.destroy(new Error("upload aborted"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal.aborted) throw new Error("upload aborted");
      yield chunk;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    stream.destroy();
  }
}
export function parseFileReadResult(value: unknown): { content: string; encoding: "base64" } {
  try {
    const result = parseProviderContract("files.read_file", value);
    if (result.encoding !== "base64") throw new Error("attachment reads must be base64");
    return { content: result.content, encoding: "base64" };
  } catch {
    throw new ValidationError("file provider returned an invalid response");
  }
}

/** Reconcile only files with a valid, Iris-created staging record. Safe to call repeatedly. */
export async function reconcileAttachmentStaging(
  now = Date.now(),
  minimumAgeMs = 0,
  useFileProvider: typeof kernel.useProvider = kernel.useProvider.bind(kernel),
): Promise<void> {
  for (const stage of listStagedAttachments(now - Math.max(0, minimumAgeMs))) {
    if (attachmentMessageExists(stage.chatId, stage.storagePath)) {
      clearAttachmentStage(stage.id);
      continue;
    }
    try {
      await useFileProvider("files", "delete_file", { filename: stage.storagePath });
      clearAttachmentStage(stage.id);
    } catch (error) {
      // Keep the record so a later reconciliation can retry. Never delete without the record.
      log.warn(JSON.stringify(eventRecord("attachments", "staging.reconciliation_deferred", {}, "warn")));
    }
  }
}

const attachmentSegmentSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "attachment path contains control characters")
  .refine((value) => !/[\\/]/.test(value), "attachment path contains a separator")
  .refine((value) => value !== "." && value !== "..", "attachment path contains a dot segment");
const attachmentChatIdSchema = attachmentSegmentSchema.refine((value) => value.length <= 256, "chat id is too long");

export function attachmentPath(pathname: string): { chatId: string; filename: string; storagePath: string } {
  const raw = pathname.replace(/^.*\/api\/files/, "").replace(/^\//, "");
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new ValidationError("invalid attachment path");
  }
  if (decoded.length > 1024) throw new ValidationError("invalid attachment path");
  const segments = decoded.split("/");
  if (segments.length !== 3 || segments[0] !== "chats") throw new ValidationError("invalid attachment path");
  const chatId = attachmentChatIdSchema.safeParse(segments[1]);
  const filename = attachmentSegmentSchema.safeParse(segments[2]);
  if (!chatId.success || !filename.success) throw new ValidationError("invalid attachment path");
  return { chatId: chatId.data, filename: filename.data, storagePath: `chats/${chatId.data}/${filename.data}` };
}

async function attachmentForViewer(request: Request, pathname: string) {
  const attachment = attachmentPath(pathname);
  const viewer = await requireChatMember(request, attachment.chatId);
  return { ...attachment, userId: viewer.userId };
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

export function validateAttachmentSignature(filename: string, bytes: Uint8Array, declaredMime?: string): void {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const expected = MIME_BY_EXTENSION[ext];
  if (!expected || (!expected.startsWith("image/") && !expected.startsWith("audio/"))) return;
  if (declaredMime && declaredMime.toLowerCase() !== expected.toLowerCase())
    throw new Error("attachment MIME type does not match filename");
  const starts = (values: number[]) => values.every((v, i) => bytes[i] === v);
  const valid =
    ext === "png"
      ? starts([137, 80, 78, 71, 13, 10, 26, 10])
      : ext === "jpg" || ext === "jpeg"
        ? starts([255, 216, 255])
        : ext === "gif"
          ? new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a" ||
            new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a"
          : ext === "webp"
            ? new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
              new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
            : ext === "avif"
              ? new TextDecoder().decode(bytes.slice(4, 8)) === "ftyp" &&
                ["avif", "avis"].includes(new TextDecoder().decode(bytes.slice(8, 12)))
              : ext === "bmp"
                ? starts([66, 77])
                : ext === "wav"
                  ? new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
                    new TextDecoder().decode(bytes.slice(8, 12)) === "WAVE"
                  : ext === "ogg"
                    ? new TextDecoder().decode(bytes.slice(0, 4)) === "OggS"
                    : ext === "flac"
                      ? new TextDecoder().decode(bytes.slice(0, 4)) === "fLaC"
                      : ext === "mp3"
                        ? new TextDecoder().decode(bytes.slice(0, 3)) === "ID3" ||
                          (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
                        : true;
  if (!valid) throw new Error("attachment content does not match its declared media type");
}

export async function processAttachmentUpload(
  filename: string,
  body: Uint8Array,
  declaredMime: string | undefined,
  persist: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  if (body.byteLength > readRuntimeLimits().attachmentBytes) throw new Error("attachment exceeds maximum size");
  validateAttachmentSignature(filename, body, declaredMime);
  await persist(body);
}

/** Cross-resource attachment commit operations. Production uses the defaults in the route;
 * tests can inject each boundary to exercise compensation without mocking the whole router. */
export interface AttachmentCommitAdapter {
  stage: (stage: Parameters<typeof stageAttachment>[0]) => void | Promise<void>;
  write: (storagePath: string, bytes: Uint8Array) => Promise<void>;
  persistMessage: () => Promise<{ id: string }>;
  finalize: (stageId: string) => void | Promise<void>;
  compensate: (storagePath: string, stageId: string) => Promise<void>;
}

export async function commitAttachment(
  stage: Parameters<typeof stageAttachment>[0],
  bytes: Uint8Array,
  adapter: AttachmentCommitAdapter,
): Promise<{ id: string }> {
  await adapter.stage(stage);
  try {
    await adapter.write(stage.storagePath, bytes);
  } catch (error) {
    if ((error as { code?: string })?.code === "conflict") {
      await adapter.finalize(stage.id);
      throw error;
    }
    try {
      await adapter.compensate(stage.storagePath, stage.id);
    } catch {
      log.error(JSON.stringify(eventRecord("attachments", "compensation.failed", { outcome: "deferred" }, "error")));
    }
    throw error;
  }
  let message: { id: string };
  try {
    message = await adapter.persistMessage();
  } catch (error) {
    try {
      await adapter.compensate(stage.storagePath, stage.id);
    } catch {
      log.error(JSON.stringify(eventRecord("attachments", "compensation.failed", { outcome: "deferred" }, "error")));
    }
    throw error;
  }
  // Once the message exists, the file is owned by it. If finalization fails, leave the
  // durable staging row for reconciliation rather than deleting a committed attachment.
  await adapter.finalize(stage.id);
  return message;
}

/** GET /api/files/:path — download a chat attachment (binary-safe). */
filesApi.get("/*", async (c) => {
  try {
    const { filename, storagePath } = await attachmentForViewer(c.req.raw, c.req.path);
    const result = parseFileReadResult(
      await kernel.useProviderContract("files.read_file", {
        filename: storagePath,
        encoding: "base64",
        max_bytes: readRuntimeLimits().attachmentBytes,
      }),
    );
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const bytes = decodeBoundedBase64(result.content, readRuntimeLimits().attachmentBytes);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": MIME_BY_EXTENSION[ext] ?? "application/octet-stream",
        "content-disposition": `inline; filename="${filename.replace(/["\\]/g, "_")}"`,
      },
    });
  } catch (e) {
    const err = toAppError(e);
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "unauthorized"
          ? 401
          : err.code === "validation_error"
            ? 400
            : err.code === "payload_too_large"
              ? 413
              : 500;
    return c.json({ error: err.code, message: err.message }, status);
  }
});

/** PUT /api/files/:path — upload a file and create its message with failure compensation. */
filesApi.put("/*", async (c) => {
  try {
    const { chatId, filename, storagePath, userId } = await attachmentForViewer(c.req.raw, c.req.path);
    const source = uploadSource(c.req.raw);
    const retryAfter = uploadLimiter.consume([`account:${userId}`, ...(source ? [`source:${source}`] : [])]);
    if (retryAfter !== undefined) return uploadRateLimitResponse(retryAfter);
    const upload = await streamToPrivateTemp(c.req.raw, {
      tempRoot: dataFile("upload-tmp"),
      limit: readRuntimeLimits().attachmentBytes,
      signal: c.req.raw.signal,
    });
    try {
      validateAttachmentSignature(filename, upload.signaturePrefix, c.req.header("content-type")?.split(";", 1)[0]);
      const chat = await getChat(chatId);
      const author = (await chat.getParticipants()).find((p) => p.role === "user" && p.userId === userId);
      if (!author) throw new Error("not in this chat");
      const stageId = uuid();
      const message = await commitAttachment(
        { id: stageId, chatId, storagePath, createdAt: Date.now() },
        upload.signaturePrefix,
        {
          stage: stageAttachment,
          write: async (target) => {
            await kernel.useProviderStream(
              "files",
              "create_file_stream",
              streamTempFile(upload.path, c.req.raw.signal),
              { filename: target, max_bytes: readRuntimeLimits().attachmentBytes },
            );
          },
          persistMessage: async () =>
            chat.sendMessage({
              chatId,
              authorId: author.id,
              type: "file",
              thought: "",
              content: `[file] ${filename}`,
            }),
          finalize: clearAttachmentStage,
          compensate: async (target, id) => {
            await kernel.useProviderContract("files.delete_file", { filename: target });
            clearAttachmentStage(id);
          },
        },
      );
      return c.json({ ok: true, messageId: message.id }, 201);
    } finally {
      await upload.cleanup();
    }
  } catch (e) {
    const err = toAppError(e);
    const conflict = (e as NodeJS.ErrnoException)?.code === "EEXIST";
    const mediaError = e instanceof Error && /^attachment (MIME type|content)/.test(e.message);
    const status = mediaError
      ? 415
      : conflict || err.code === "conflict"
        ? 409
        : err.code === "unauthorized"
          ? 401
          : err.code === "validation_error"
            ? 400
            : err.code === "payload_too_large"
              ? 413
              : 500;
    return c.json(
      { error: conflict ? "conflict" : err.code, message: conflict ? "attachment already exists" : err.message },
      status,
    );
  }
});
