import type { ModelAdmissionLease } from "./model-admission.js";

export function reserveMessageAdmission(input: {
  userId: string;
  source?: string;
  targetCount: number;
  tryAcquire: (keys: readonly string[], slots: number) => ModelAdmissionLease[] | undefined;
}): ModelAdmissionLease[] | undefined {
  if (input.targetCount === 0) return [];
  const keys = [`account:${input.userId}`, ...(input.source ? [`source:${input.source}`] : [])];
  return input.tryAcquire(keys, input.targetCount);
}
