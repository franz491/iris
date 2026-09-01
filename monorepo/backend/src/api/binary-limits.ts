import { PayloadTooLargeError, ValidationError } from "../misc/error.js";
import { randomUUID } from "node:crypto";
import { open, mkdir, lstat, unlink, chmod } from "node:fs/promises";
import path from "node:path";

// Compatibility defaults; request paths use readRuntimeLimits() at call time.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_AUDIO_HANDLE_BYTES = 10 * 1024 * 1024;
export const MAX_STT_BYTES = 25 * 1024 * 1024;
export const MIN_WAV_BYTES = 44;
const UPLOAD_SIGNATURE_PREFIX_BYTES = 512;

export interface PrivateTempUpload {
  path: string;
  bytes: number;
  signaturePrefix: Uint8Array;
  cleanup: () => Promise<void>;
}

/** Stream a request into a private, bounded temp file without buffering its body. */
export async function streamToPrivateTemp(
  request: Request,
  options: { tempRoot: string; limit: number; signal?: AbortSignal },
): Promise<PrivateTempUpload> {
  if (!Number.isSafeInteger(options.limit) || options.limit < 0) throw new Error("invalid upload limit");
  if (declaredBodyExceedsLimit(request.headers.get("content-length"), options.limit)) {
    throw new PayloadTooLargeError(`request body exceeds ${options.limit} bytes`);
  }
  const declaredLength = parseDeclaredLength(request.headers.get("content-length"));
  if (options.signal?.aborted) throw new Error("upload aborted");
  await mkdir(options.tempRoot, { recursive: true, mode: 0o700 });
  const root = await lstat(options.tempRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("upload temp root must be a real directory");
  await chmod(options.tempRoot, 0o700);
  const tempPath = path.join(options.tempRoot, `upload-${randomUUID()}.tmp`);
  const file = await open(tempPath, "wx", 0o600);
  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    removed = true;
    await unlink(tempPath).catch(() => undefined);
  };
  const body = request.body;
  if (!body) {
    await file.close();
    return { path: tempPath, bytes: 0, signaturePrefix: new Uint8Array(), cleanup };
  }
  const reader = body.getReader();
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  let total = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (options.signal?.aborted) throw new Error("upload aborted");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.limit) throw new PayloadTooLargeError(`request body exceeds ${options.limit} bytes`);
      if (prefixBytes < UPLOAD_SIGNATURE_PREFIX_BYTES) {
        const take = value.subarray(0, UPLOAD_SIGNATURE_PREFIX_BYTES - prefixBytes);
        prefix.push(take.slice());
        prefixBytes += take.byteLength;
      }
      await file.writeFile(value);
    }
    if (declaredLength !== undefined && declaredLength !== total) {
      throw new ValidationError("request body length does not match content-length");
    }
    await file.sync();
    const signaturePrefix = new Uint8Array(prefixBytes);
    let prefixOffset = 0;
    for (const chunk of prefix) {
      signaturePrefix.set(chunk, prefixOffset);
      prefixOffset += chunk.byteLength;
    }
    return {
      path: tempPath,
      bytes: total,
      signaturePrefix,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    await file.close();
  }
}

export function declaredBodyExceedsLimit(contentLength: string | null, limit: number): boolean {
  if (contentLength === null || !/^\d+$/.test(contentLength)) return false;
  return Number(contentLength) > limit;
}

function parseDeclaredLength(contentLength: string | null): number | undefined {
  if (contentLength === null || !/^\d+$/.test(contentLength)) return undefined;
  const length = Number(contentLength);
  return Number.isSafeInteger(length) ? length : undefined;
}

/** Read a request body without allowing an attacker-controlled unbounded buffer. */
export async function readBoundedBody(request: Request, limit: number): Promise<Buffer> {
  if (declaredBodyExceedsLimit(request.headers.get("content-length"), limit)) {
    throw new PayloadTooLargeError(`request body exceeds ${limit} bytes`);
  }
  if (!request.body) return Buffer.alloc(0);
  const declaredLength = parseDeclaredLength(request.headers.get("content-length"));

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        throw new PayloadTooLargeError(`request body exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
    if (declaredLength !== undefined && declaredLength !== total) {
      throw new ValidationError("request body length does not match content-length");
    }
  } finally {
    if (total > limit) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/** Read an upstream response with the same hard memory bound as request data. */
export async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (
    response.headers.get("content-length") &&
    declaredBodyExceedsLimit(response.headers.get("content-length"), limit)
  ) {
    throw new PayloadTooLargeError(`response body exceeds ${limit} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const declaredLength = parseDeclaredLength(response.headers.get("content-length"));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new PayloadTooLargeError(`response body exceeds ${limit} bytes`);
      chunks.push(value);
    }
    if (declaredLength !== undefined && declaredLength !== total) {
      throw new ValidationError("response body length does not match content-length");
    }
  } finally {
    if (total > limit) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function validateWavUpload(bytes: Buffer, mimeType: string): string {
  const normalizedMime = mimeType.split(";", 1)[0].trim().toLowerCase();
  if (!["audio/wav", "audio/x-wav"].includes(normalizedMime)) {
    throw new ValidationError("audio handle must use audio/wav content type");
  }
  const hasWavHeader =
    bytes.length >= MIN_WAV_BYTES &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE";
  if (!hasWavHeader) throw new ValidationError("audio handle must contain a WAV file");
  return "audio/wav";
}

export function decodeBoundedBase64(value: string, limit: number): Buffer {
  if (value.length > Math.ceil((limit * 4) / 3) + 4) {
    throw new PayloadTooLargeError(`file exceeds ${limit} bytes`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit) throw new PayloadTooLargeError(`file exceeds ${limit} bytes`);
  return bytes;
}
