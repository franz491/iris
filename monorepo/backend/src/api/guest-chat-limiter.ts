import { readRuntimeLimits } from "../config/runtime-limits.js";

/** Fixed-window abuse controls for the shared unauthenticated guest chat. */
export const GUEST_CHAT_ACCESS_LIMIT_PER_WINDOW = 30;
export const GUEST_CHAT_MESSAGE_LIMIT_PER_WINDOW = 20;

type Entry = { count: number; firstAt: number };

class GuestChatLimiter {
  private readonly entries = new Map<string, Entry>();

  consume(key: string, limit: number, now = Date.now()): number | undefined {
    const limits = readRuntimeLimits();
    if (!key || !Number.isSafeInteger(limit) || limit < 1) return undefined;
    for (const [entryKey, entry] of this.entries) {
      if (now - entry.firstAt >= limits.abuseWindowMs) this.entries.delete(entryKey);
    }
    const current = this.entries.get(key);
    if (current && current.count >= limit) {
      return Math.max(1, Math.ceil(Math.max(0, limits.abuseWindowMs - (now - current.firstAt)) / 1000));
    }
    if (current) current.count += 1;
    else this.entries.set(key, { count: 1, firstAt: now });
    while (this.entries.size > limits.limiterKeyCapacity)
      this.entries.delete(this.entries.keys().next().value as string);
    return undefined;
  }

  reset(): void {
    this.entries.clear();
  }
}

export const guestChatLimiter = new GuestChatLimiter();
export function resetGuestChatLimiter(): void {
  guestChatLimiter.reset();
}

export function guestChatRateLimitResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", message: "Too many guest chat requests; try again later." }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfter),
        "cache-control": "no-store",
      },
    },
  );
}
