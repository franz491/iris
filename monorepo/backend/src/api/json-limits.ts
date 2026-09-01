import { declaredBodyExceedsLimit } from "./binary-limits.js";
import { readRuntimeLimits } from "../config/runtime-limits.js";

export const MAX_JSON_BODY_BYTES = 1024 * 1024;
export const DEFAULT_JSON_BODY_TIMEOUT_MS = 30_000;

export type JsonBodyProbeResult = "ok" | "too_large" | "timeout" | "aborted";

export function jsonBodyTimeoutMs(value = process.env.IRIS_JSON_BODY_TIMEOUT_MS): number {
  if (value === undefined) return readRuntimeLimits().jsonBodyTimeoutMs;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), 5 * 60_000)
    : DEFAULT_JSON_BODY_TIMEOUT_MS;
}

export function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

export function declaresOversizedJson(request: Request, limit = readRuntimeLimits().jsonBodyBytes): boolean {
  return (
    isJsonContentType(request.headers.get("content-type")) &&
    declaredBodyExceedsLimit(request.headers.get("content-length"), limit)
  );
}

/**
 * Probe a cloned JSON body without consuming the original request. The probe
 * has both a hard byte bound and a finite wait budget, and always releases its
 * clone reader so slow/disconnected clients cannot strand request resources.
 */
export async function probeJsonBody(
  request: Request,
  options: { limit?: number; signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<JsonBodyProbeResult> {
  const limit = options.limit ?? readRuntimeLimits().jsonBodyBytes;
  if (!isJsonContentType(request.headers.get("content-type"))) return "ok";
  if (declaresOversizedJson(request, limit)) return "too_large";
  if (options.signal?.aborted || request.signal.aborted) return "aborted";
  if (!request.body) return "ok";
  // A caller may invoke the helper after another middleware has consumed the
  // body. Do not turn that framework state into an unexpected 500; the route's
  // own parser will return its normal validation error.
  if (request.bodyUsed) return "ok";

  let clone: Request;
  try {
    clone = request.clone();
  } catch {
    return "ok";
  }
  const reader = clone.body?.getReader();
  if (!reader) return "ok";
  const deadline = jsonBodyTimeoutMs(
    options.deadlineMs === undefined ? process.env.IRIS_JSON_BODY_TIMEOUT_MS : String(options.deadlineMs),
  );
  const started = Date.now();
  let aborted = false;
  const abort = () => {
    aborted = true;
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    let total = 0;
    while (true) {
      if (aborted || options.signal?.aborted || request.signal.aborted) return "aborted";
      const remaining = deadline - (Date.now() - started);
      if (remaining <= 0) return "timeout";
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = reader.read().then(
        (value) => ({ kind: "read" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const waited = await Promise.race([
        read,
        new Promise<{ kind: "timeout" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "timeout" }), remaining);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (waited.kind === "timeout") return "timeout";
      if (waited.kind === "error") throw waited.error;
      if (waited.value.done) return "ok";
      total += waited.value.value.byteLength;
      if (total > limit) return "too_large";
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    request.signal.removeEventListener("abort", abort);
    // A cloned undici stream may wait for the untouched original branch when
    // cancellation is awaited. Fire cancellation without making the response
    // deadline depend on a producer that may never close.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * Check both declared and streamed JSON sizes without consuming the request
 * body used by the route. Cloning is intentional: this runs as middleware
 * before Hono parses the body, and prevents chunked requests from bypassing
 * the declared Content-Length guard.
 */
export async function streamedJsonExceedsLimit(
  request: Request,
  limit = readRuntimeLimits().jsonBodyBytes,
): Promise<boolean> {
  return (await probeJsonBody(request, { limit })) === "too_large";
}

export function jsonTooLargeResponse(limit = readRuntimeLimits().jsonBodyBytes): Response {
  return Response.json(
    { error: "payload_too_large", message: `JSON request body exceeds ${limit} bytes` },
    { status: 413 },
  );
}

export function jsonBodyTimeoutResponse(): Response {
  return Response.json({ error: "request_timeout", message: "request body deadline exceeded" }, { status: 408 });
}

export function jsonBodyAbortedResponse(): Response {
  return Response.json({ error: "request_aborted", message: "request was aborted" }, { status: 499 });
}
