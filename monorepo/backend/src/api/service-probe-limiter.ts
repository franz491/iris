import { readRuntimeLimits } from "../config/runtime-limits.js";

/** Fixed-window limiter for the fan-out admin service probe operation. */
export const SERVICE_PROBE_LIMIT_PER_WINDOW = 10;

type Entry = { count: number; firstAt: number };

class ServiceProbeLimiter {
  private readonly entries = new Map<string, Entry>();

  consume(keys: readonly string[], now = Date.now()): number | undefined {
    const unique = [...new Set(keys)].filter(Boolean);
    const limits = readRuntimeLimits();
    if (unique.length === 0) return undefined;
    for (const [key, entry] of this.entries) {
      if (now - entry.firstAt >= limits.abuseWindowMs) this.entries.delete(key);
    }
    const blocked = unique
      .map((key) => this.entries.get(key))
      .filter((entry): entry is Entry => Boolean(entry && entry.count >= limits.serviceProbesPerWindow));
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

export const serviceProbeLimiter = new ServiceProbeLimiter();
export function resetServiceProbeLimiter(): void {
  serviceProbeLimiter.reset();
}

export function serviceProbeRateLimitResponse(retryAfter: number): Response {
  return new Response(JSON.stringify({ error: "rate_limited", message: "Too many service probes; try again later." }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfter),
      "cache-control": "no-store",
    },
  });
}
