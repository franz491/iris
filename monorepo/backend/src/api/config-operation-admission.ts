import { uploadSource } from "./upload-limiter.js";
import { readRuntimeLimits } from "../config/runtime-limits.js";

const active = new Map<string, number>();
export const MAX_CONFIG_ADMISSION_KEYS = 20_000;

export function configOperationKeys(request: Request, account: string): string[] {
  const source = uploadSource(request);
  return [`account:${account}`, ...(source ? [`source:${source}`] : [])];
}
export function tryConfigOperationAdmission(keys: readonly string[]): (() => void) | undefined {
  const unique = [...new Set(keys)].filter(Boolean);
  const limits = readRuntimeLimits();
  if (unique.length === 0 || unique.some((key) => (active.get(key) ?? 0) >= limits.configActive)) return undefined;
  const newKeys = unique.filter((key) => !active.has(key));
  if (active.size + newKeys.length > limits.limiterKeyCapacity) return undefined;
  unique.forEach((key) => active.set(key, (active.get(key) ?? 0) + 1));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    unique.forEach((key) => {
      const count = (active.get(key) ?? 1) - 1;
      if (count > 0) active.set(key, count);
      else active.delete(key);
    });
  };
}
export function resetConfigOperationAdmission(): void {
  active.clear();
}
export function configOperationRateLimitResponse(): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", message: "Too many configuration operations; try later." }),
    {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "1", "cache-control": "no-store" },
    },
  );
}
