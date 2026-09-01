import { z } from "zod";

const MAX_BINARY_BASE64_CHARS = 14 * 1024 * 1024;
const MAX_TEXT_CHARS = 14 * 1024 * 1024;
const base64Content = z
  .string()
  .max(MAX_BINARY_BASE64_CHARS)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "invalid base64 content");

const okResult = z.object({ ok: z.literal(true) }).strict();
const boundedJson: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(MAX_TEXT_CHARS),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(boundedJson).max(256),
    z.record(z.string().max(128), boundedJson),
  ]),
);
const boundedObject = z.record(z.string().max(128), boundedJson);

export const providerContracts = {
  "models.list": z
    .object({
      data: z
        .array(
          z
            .object({
              id: z
                .string()
                .min(1)
                .max(512)
                .regex(/^[^\u0000-\u001f\u007f]+$/),
            })
            .passthrough(),
        )
        .max(256),
    })
    .strict(),
  "files.read_file": z.union([
    z.object({ content: base64Content, encoding: z.literal("base64") }).strict(),
    z.object({ content: z.string().max(MAX_TEXT_CHARS), encoding: z.literal("utf8") }).strict(),
  ]),
  "tts.synthesize": z
    .object({
      _irisAudio: z
        .object({
          base64: z.string().min(1).max(MAX_BINARY_BASE64_CHARS),
          mimeType: z.string().min(1).max(128).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  "files.create_file": okResult,
  "files.delete_file": okResult,
  "files.search_and_replace": okResult,
  "files.edit_file": okResult,
  "files.edit_lines": okResult,
  // Shell remains descriptor-dynamic until its platform-specific result is formalized.
  "files.shell": z.object({ stdout: z.string().max(MAX_TEXT_CHARS), stderr: z.string().max(MAX_TEXT_CHARS) }).strict(),
  "memory.list_keywords": z.object({ keywords: z.array(z.string().min(1).max(512)).max(1024) }).strict(),
  "memory.list_memories": z
    .object({
      memories: z
        .array(
          z
            .object({
              id: z.string().min(1).max(256),
              keywords: z.array(z.string().min(1).max(512)).max(128),
              content: z.string().min(1).max(MAX_TEXT_CHARS),
              createdAt: z.string().datetime({ offset: true }),
              isPrivate: z.boolean(),
            })
            .strict(),
        )
        .max(4096),
    })
    .strict(),
  "memory.add_memory": z
    .object({
      ok: z.literal(true),
      id: z.string().min(1).max(256),
      keywords: z.array(z.string().min(1).max(512)).max(128),
      hint: z.string().min(1).max(1024),
    })
    .strict(),
  "memory.remove_memory": okResult,
  "docs.list_docs": z.object({ docs: z.array(z.string().min(1).max(512)).max(4096) }).strict(),
  "docs.read_structure": z.object({ structure: z.string().max(262_144) }).strict(),
  "docs.read_file": z.object({ content: z.string().max(262_144) }).strict(),
  "docs.search": z.object({ results: z.string().max(262_144) }).strict(),
  "docs.search_regex": z.object({ results: z.string().max(262_144) }).strict(),
  "audio.refresh_devices": z
    .object({
      devices: z
        .array(
          z
            .object({
              id: z.string().min(1).max(256),
              name: z.string().min(1).max(512),
              direction: z.enum(["in", "out"]),
            })
            .strict(),
        )
        .max(256),
    })
    .strict(),
  "audio.stream_audio": okResult,
  // The stream itself is intentionally not returned through the JSON contract.
  "audio.read_audio": z.object({ kind: z.literal("audio_stream"), version: z.literal(1) }).strict(),
  "admin-setup.list_sections": z.array(z.string().min(1).max(128)).max(64),
  "admin-setup.read_section": boundedObject,
  "admin-setup.get_options": boundedObject,
  "admin-setup.propose_patch": boundedObject,
  "admin-setup.validate_patch": boundedObject,
  "search.search": z
    .object({
      results: z
        .array(
          z
            .object({ title: z.string().max(2000), url: z.string().url().max(4096), snippet: z.string().max(2000) })
            .strict(),
        )
        .max(20),
    })
    .strict(),
  "shell.shell_oneshot": z
    .object({
      code: z.number().int(),
      stdout: z.string().max(MAX_TEXT_CHARS),
      stderr: z.string().max(MAX_TEXT_CHARS),
      cwd: z.literal("/sandbox"),
    })
    .strict(),
  "shell.shell_interactive": z
    .object({ kind: z.literal("interactive_session"), version: z.literal(1), sessionId: z.string().min(1).max(128) })
    .strict(),
} as const;
export type ProviderContractKey = keyof typeof providerContracts;
export type ProviderContract<K extends ProviderContractKey> = z.infer<(typeof providerContracts)[K]>;
export function parseModelCatalog(value: unknown): Array<{ id: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const item = providerContracts["models.list"].shape.data.element;
  return data.slice(0, 256).flatMap((entry) => {
    const result = item.safeParse(entry);
    return result.success ? [{ id: result.data.id }] : [];
  });
}
export function parseProviderContract<K extends ProviderContractKey>(key: K, value: unknown): ProviderContract<K> {
  return providerContracts[key].parse(value) as ProviderContract<K>;
}

/** Minimal JSON-schema gate for runtime-selected descriptor payloads. */
export function validateDescriptorJson(value: unknown, schema: Record<string, unknown>): unknown {
  let fieldCount = 0;
  const visit = (input: unknown, shape: Record<string, unknown>, depth: number): unknown => {
    if (depth > 32 || ++fieldCount > 1024) throw new Error("provider payload exceeds bounds");
    for (const key of Object.keys(shape))
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("malformed provider schema");
    const allowed = new Set([
      "type",
      "enum",
      "const",
      "required",
      "properties",
      "items",
      "additionalProperties",
      "anyOf",
      "oneOf",
      "allOf",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "pattern",
      "format",
      "default",
      "description",
      "title",
      "definitions",
      "$defs",
      "$ref",
      "$schema",
    ]);
    for (const key of Object.keys(shape))
      if (!allowed.has(key)) throw new Error(`unsupported provider schema keyword: ${key}`);
    // zod-to-json-schema emits shared definitions; referenced sub-schemas are
    // already validated by their originating Zod contract at this boundary.
    if (typeof shape.$ref === "string") return input;
    if (
      shape.type !== undefined &&
      !(Array.isArray(shape.type)
        ? shape.type.every((type) =>
            ["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(type)),
          )
        : ["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(shape.type)))
    )
      throw new Error(`unsupported provider schema type: ${String(shape.type)}`);
    if (
      shape.required !== undefined &&
      (!Array.isArray(shape.required) || shape.required.some((key) => typeof key !== "string"))
    )
      throw new Error("malformed provider schema required");
    if (
      shape.properties !== undefined &&
      (!shape.properties || typeof shape.properties !== "object" || Array.isArray(shape.properties))
    )
      throw new Error("malformed provider schema properties");
    if (shape.items !== undefined && (!shape.items || typeof shape.items !== "object" || Array.isArray(shape.items)))
      throw new Error("malformed provider schema items");
    if (Array.isArray(shape.enum) && !shape.enum.some((item) => Object.is(item, input)))
      throw new Error("provider payload enum mismatch");
    if (Object.hasOwn(shape, "const") && !Object.is(shape.const, input))
      throw new Error("provider payload const mismatch");
    if (shape.type === "null" && input !== null) throw new Error("provider payload must be null");
    if (shape.type === "boolean" && typeof input !== "boolean") throw new Error("provider payload must be boolean");
    if (
      (shape.type === "number" || shape.type === "integer") &&
      (typeof input !== "number" || !Number.isFinite(input) || (shape.type === "integer" && !Number.isInteger(input)))
    )
      throw new Error("provider payload must be numeric");
    if (shape.type === "string" && typeof input !== "string") throw new Error("provider payload must be a string");
    if (shape.type === "array") {
      if (!Array.isArray(input)) throw new Error("provider payload must be an array");
      if (shape.items && typeof shape.items === "object")
        input.forEach((item) => visit(item, shape.items as Record<string, unknown>, depth + 1));
    }
    if (shape.type === "object") {
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("provider payload must be an object");
      const record = input as Record<string, unknown>;
      const properties =
        shape.properties && typeof shape.properties === "object" ? (shape.properties as Record<string, unknown>) : {};
      for (const key of Object.hasOwn(shape, "$schema") ? [] : Array.isArray(shape.required) ? shape.required : [])
        if (
          typeof key === "string" &&
          !(key in record) &&
          !(properties[key] && typeof properties[key] === "object" && Object.hasOwn(properties[key], "default"))
        )
          throw new Error(`provider payload missing ${key}`);
      if (shape.additionalProperties === false)
        for (const key of Object.keys(record))
          if (!(key in properties)) throw new Error("unexpected provider payload field");
      for (const key of Object.keys(record))
        if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("unsafe provider payload key");
      for (const [key, child] of Object.entries(properties))
        if (key in record && child && typeof child === "object")
          visit(record[key], child as Record<string, unknown>, depth + 1);
    }
    return input;
  };
  return visit(value, schema, 0);
}
