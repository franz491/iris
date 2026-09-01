// misc/utils.ts
import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "./types.js";

export type { JsonValue, JsonObject };

export const uuid = (): string => randomUUID();
export const now = (): number => Date.now();

/** Type guard: is the value a plain JSON-serializable object? */
export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
