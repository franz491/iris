// llama.cpp router: OpenAI-compatible completions plus llama-server metadata.
import { OpenAiCompatRouter } from "./openai-compat.js";
import type { ModelInfo } from "./types.js";
import { pinnedFetch } from "../net/pinned-http.js";
import { isSafeModelId } from "./openai-compat.js";
import { z } from "zod";

const llamaModelSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    meta: z
      .object({ n_ctx: z.union([z.number(), z.string().max(32)]) })
      .partial()
      .optional(),
    status: z
      .object({ args: z.array(z.string().max(256)).max(128), preset: z.string().max(1024) })
      .partial()
      .optional(),
  })
  .passthrough();

export class LlamaCppRouter extends OpenAiCompatRouter {
  override async listModels(): Promise<ModelInfo[]> {
    try {
      const res = await pinnedFetch(
        new URL(`${this.baseUrl().replace(/\/$/, "")}/models`),
        { headers: this.headers() },
        2 * 1024 * 1024,
      );
      if (!res.ok) return [];
      const json: unknown = await res.json();
      const data =
        json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>).data : undefined;
      if (!Array.isArray(data)) return [];
      return data.slice(0, 256).flatMap((model) => {
        const parsed = llamaModelSchema.safeParse(model);
        if (!parsed.success || !isSafeModelId(parsed.data.id)) return [];
        const entry = parsed.data;
        const contextWindow = llamaContextWindow(entry);
        return [
          {
            id: entry.id,
            contextWindow,
          },
        ];
      });
    } catch {
      return [];
    }
  }
}

/** llama-server has emitted both loaded-model metadata and preset-router shapes. */
export function llamaContextWindow(model: {
  meta?: { n_ctx?: number | string };
  status?: { args?: string[]; preset?: string };
}): number | undefined {
  const candidates: unknown[] = [model.meta?.n_ctx];
  const args = model.status?.args ?? [];
  const argIndex = args.indexOf("--ctx-size");
  if (argIndex >= 0) candidates.push(args[argIndex + 1]);
  const presetMatch = model.status?.preset?.match(/^ctx-size\s*=\s*(\d+)\s*$/m);
  if (presetMatch) candidates.push(presetMatch[1]);
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}
