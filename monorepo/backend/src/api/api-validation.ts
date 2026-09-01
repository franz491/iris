import { z } from "zod";
import { ValidationError } from "../misc/error.js";

export const routeIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "identifier contains control characters");

export function parseRouteId(value: string, label: string): string {
  const result = routeIdSchema.safeParse(value);
  if (!result.success) throw new ValidationError(`invalid ${label}`, result.error.flatten());
  return result.data;
}

export function parseStrictSingleQuery<T extends z.ZodTypeAny>(request: Request, schema: T, label: string): z.infer<T> {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, string> = {};
  for (const key of new Set([...params.keys()])) {
    const values = params.getAll(key);
    if (values.length !== 1) {
      throw new ValidationError(`invalid ${label} query`, {
        formErrors: ["query parameters must occur at most once"],
        fieldErrors: {},
      });
    }
    raw[key] = values[0]!;
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new ValidationError(`invalid ${label} query`, result.error.flatten());
  return result.data as z.infer<T>;
}
