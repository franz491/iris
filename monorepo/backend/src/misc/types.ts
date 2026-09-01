// misc/types.ts
// PromiEvent from the original spec was cut (see misc/types.md ASSUMPTIONS).

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type JsonObject = { [k: string]: JsonValue };
