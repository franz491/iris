// providers/installed/search.ts — web search via DuckDuckGo HTML endpoint.
// Server-side execution avoids browser CORS restrictions. Results are parsed
// from the lightweight HTML page (no API key required). This remains an
// experimental, bounded compatibility parser until a supported search API is
// available.
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BaseProvider } from "../base.js";
import type { ProviderDescriptor, SchemaObject } from "../types.js";
import type { ProviderConfig } from "../../runtime/types.js";
import { AppError } from "../../misc/error.js";
import { readBoundedResponse } from "../../api/binary-limits.js";
import { pinnedFetch } from "../../net/pinned-http.js";
import { readRuntimeLimits } from "../../config/runtime-limits.js";

const json = (s: z.ZodTypeAny): SchemaObject => zodToJsonSchema(s, { target: "openAi" }) as SchemaObject;

const searchSchema = z.object({
  query: z.string().describe("the search query"),
  limit: z.number().int().positive().max(20).optional().default(8),
});

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
const searchResultSchema = z.object({
  results: z
    .array(z.object({ title: z.string().max(2000), url: z.string().url().max(4096), snippet: z.string().max(2000) }))
    .max(20),
});

/** Parse result links out of the DuckDuckGo HTML page. */
export function parseResults(html: string, limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  // results look like: <a rel="nofollow" class="result__a" href="URL">TITLE</a>
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html)) !== null) {
    snippets.push(stripTags(sm[1]));
  }
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null && out.length < limit) {
    let url = lm[1];
    // DDG wraps URLs: //duckduckgo.com/l/?uddg=<encoded>&rut=...
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) continue;
    const normalizedUrl = parsed.toString();
    if (normalizedUrl.length > 4096) continue;
    out.push({
      title: stripTags(lm[2]).slice(0, 2000),
      url: normalizedUrl,
      snippet: (snippets[out.length] ?? "").slice(0, 2000),
    });
  }
  return out;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export class SearchProvider extends BaseProvider {
  readonly providerDescriptor: ProviderDescriptor = {
    name: "search",
    description: "Web search for the AI (DuckDuckGo-backed).",
    options: [
      {
        name: "search",
        description: "Search the web.",
        kwargsSchema: json(searchSchema),
        returnSchema: json(searchResultSchema),
      },
    ],
    additionalConfig: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", default: 15000 },
        safeSearch: { type: "boolean", default: true },
      },
    },
  };

  private timeoutMs = 15000;

  async setConfig(newConfig: ProviderConfig): Promise<void> {
    this.config = newConfig;
    this.timeoutMs = this.setting<number>("timeoutMs", 15000);
    this.emit("reload");
  }

  async callFunctionality(functionality: string, kwargs: unknown): Promise<unknown> {
    if (!this.isFunctionalityActive(functionality)) {
      throw new AppError(`functionality "${functionality}" is not active`, "functionality_inactive");
    }
    if (functionality !== "search") {
      throw new AppError(`unknown functionality "${functionality}"`, "unknown_functionality");
    }
    const k = searchSchema.parse(kwargs);
    const params = new URLSearchParams({
      q: k.query,
      kp: this.setting<boolean>("safeSearch", true) ? "1" : "-1",
    });
    const res = await pinnedFetch(
      new URL(`https://html.duckduckgo.com/html/?${params}`),
      {
        headers: {
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 iris-search/0.1",
        },
      },
      readRuntimeLimits().searchResponseBytes,
      this.timeoutMs,
    );
    if (!res.ok) throw new AppError(`search failed: ${res.status}`, "search_failed");
    const html = (await readBoundedResponse(res, readRuntimeLimits().searchResponseBytes)).toString("utf8");
    return { results: parseResults(html, k.limit) };
  }
}
