import { readRuntimeLimits } from "../config/runtime-limits.js";

/** Small, process-local upload abuse limiter. The source key is injected by
 * the HTTP adapter (see index.ts); forwarded client headers are never read. */
export const UPLOAD_LIMIT_PER_WINDOW = 10;
const MAX_SOURCE_BYTES = 255;
const trustedSources = new WeakMap<Request, string>();

type Entry = { count: number; firstAt: number };

class UploadLimiter {
  private readonly entries = new Map<string, Entry>();

  private purge(now: number): void {
    const windowMs = readRuntimeLimits().abuseWindowMs;
    for (const [key, entry] of this.entries) {
      if (now - entry.firstAt >= windowMs) this.entries.delete(key);
    }
  }

  /** Atomically consumes one attempt for every key, or none if any is full. */
  consume(keys: readonly string[], now = Date.now()): number | undefined {
    const unique = [...new Set(keys)].filter(Boolean);
    const limits = readRuntimeLimits();
    if (unique.length === 0) return undefined;
    this.purge(now);
    const blocked = unique
      .map((key) => this.entries.get(key))
      .filter((entry): entry is Entry => Boolean(entry && entry.count >= limits.uploadPerWindow));
    if (blocked.length > 0) {
      return Math.max(
        1,
        Math.ceil(Math.max(...blocked.map((entry) => limits.abuseWindowMs - (now - entry.firstAt))) / 1000),
      );
    }
    for (const key of unique) {
      const entry = this.entries.get(key);
      if (entry) entry.count += 1;
      else this.entries.set(key, { count: 1, firstAt: now });
    }
    while (this.entries.size > limits.limiterKeyCapacity)
      this.entries.delete(this.entries.keys().next().value as string);
    return undefined;
  }

  reset(): void {
    this.entries.clear();
  }
}

export const uploadLimiter = new UploadLimiter();
export function resetUploadLimiter(): void {
  uploadLimiter.reset();
}

/** The main adapter overwrites this internal header with the peer address. */
export function uploadSource(request: Request): string | undefined {
  const source = trustedSources.get(request)?.trim();
  if (!source || Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) return undefined;
  // Adapter-provided peer addresses are single-line values. Treat malformed
  // values as absent rather than allowing control characters into limiter keys.
  if (/[\u0000-\u001f\u007f]/u.test(source)) return undefined;
  return source;
}

export function registerTrustedSource(request: Request, source: string | undefined): void {
  if (source) trustedSources.set(request, source);
}

export function uploadRateLimitResponse(retryAfter: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited", message: "Too many uploads; try again later." }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfter),
      "cache-control": "no-store",
    },
  });
}
