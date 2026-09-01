/** Shared dependency-free primitives for runtime JSON response guards. */
export type JsonRecord = Record<string, unknown>;
export const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const isString = (value: unknown): value is string => typeof value === "string";
export const isNonEmptyString = (value: unknown): value is string => isString(value) && value.length > 0;
export const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const isBootstrapStatus = (value: unknown): value is { configured: boolean } =>
  isRecord(value) && typeof value.configured === "boolean";
