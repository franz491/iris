import { uploadSource } from "./upload-limiter.js";
import { readRuntimeLimits } from "../config/runtime-limits.js";

export const MAX_CREDENTIAL_ADMISSION_KEYS = 20_000;

export class CredentialAdmission {
  private readonly entries = new Map<string, number>();

  constructor(private readonly maxKeys?: number) {}

  tryAcquire(keys: readonly string[]): (() => void) | undefined {
    const unique = [...new Set(keys)];
    const limits = readRuntimeLimits();
    if (unique.some((key) => (this.entries.get(key) ?? 0) >= limits.credentialActive)) return undefined;
    const newKeys = unique.filter((key) => !this.entries.has(key));
    const keyCapacity = Math.min(this.maxKeys ?? limits.limiterKeyCapacity, limits.limiterKeyCapacity);
    if (this.entries.size + newKeys.length > keyCapacity) return undefined;
    unique.forEach((key) => this.entries.set(key, (this.entries.get(key) ?? 0) + 1));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      unique.forEach((key) => {
        const count = (this.entries.get(key) ?? 1) - 1;
        if (count > 0) this.entries.set(key, count);
        else this.entries.delete(key);
      });
    };
  }

  reset(): void {
    this.entries.clear();
  }
}

const admission = new CredentialAdmission();

export function credentialKeys(request: Request, account?: string, includeBootstrap = true): string[] {
  const source = uploadSource(request);
  return [
    account ? `account:${account}` : includeBootstrap ? "bootstrap" : null,
    ...(source ? [`source:${source}`] : []),
  ].filter((key): key is string => Boolean(key));
}
export function tryCredentialAdmission(keys: readonly string[]): (() => void) | undefined {
  return admission.tryAcquire(keys);
}
export function resetCredentialAdmission(): void {
  admission.reset();
}
export function credentialRateLimitResponse(): Response {
  return new Response(JSON.stringify({ error: "rate_limited", message: "Too many credential changes; try later." }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1", "cache-control": "no-store" },
  });
}
