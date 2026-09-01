import { readRuntimeLimits } from "../config/runtime-limits.js";

export const MAX_ACTIVE_MODEL_REQUESTS = 2;

type Entry = { active: number; lastAt: number };
export interface ModelAdmissionLease {
  release(): void;
}

class Admission implements ModelAdmissionLease {
  private released = false;
  constructor(private readonly releaseFn: () => void) {}
  release(): void {
    if (this.released) return;
    this.released = true;
    this.releaseFn();
  }
}

class ModelAdmission {
  private readonly entries = new Map<string, Entry>();
  tryAcquire(keys: readonly string[], slots = 1, now = Date.now()): ModelAdmissionLease[] | undefined {
    const unique = [...new Set(keys)].filter(Boolean);
    const limits = readRuntimeLimits();
    if (!Number.isSafeInteger(slots) || slots < 1 || unique.length === 0) return undefined;
    // Active leases are never expired by the idle-window cleanup. Otherwise a
    // long generation would disappear from accounting while still consuming a
    // slot and allow an overlapping request.
    for (const [key, value] of this.entries)
      if (value.active === 0 && now - value.lastAt >= limits.abuseWindowMs) this.entries.delete(key);
    if (unique.some((key) => (this.entries.get(key)?.active ?? 0) + slots > limits.modelActive)) return undefined;
    for (const key of unique) {
      const value = this.entries.get(key) ?? { active: 0, lastAt: now };
      value.active += slots;
      value.lastAt = now;
      this.entries.set(key, value);
    }
    const release = () => {
      for (const key of unique) {
        const value = this.entries.get(key);
        if (!value) continue;
        value.active = Math.max(0, value.active - 1);
        value.lastAt = Date.now();
        if (value.active === 0) this.entries.delete(key);
      }
    };
    const leases = Array.from({ length: slots }, () => new Admission(release));
    while (this.entries.size > limits.limiterKeyCapacity) {
      const idle = [...this.entries].find(([, value]) => value.active === 0);
      if (!idle) break;
      this.entries.delete(idle[0]);
    }
    return leases;
  }
  reset(): void {
    this.entries.clear();
  }
}

export const modelAdmission = new ModelAdmission();
export function resetModelAdmission(): void {
  modelAdmission.reset();
}
export function modelRateLimitResponse(): Response {
  return new Response(JSON.stringify({ error: "rate_limited", message: "Too many model requests; try again later." }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1", "cache-control": "no-store" },
  });
}
