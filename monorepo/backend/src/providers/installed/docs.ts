// providers/installed/docs.ts
// Read-only access to topic folders under docs/ for AI self-education.
import { promises as fs } from "node:fs";
import path from "node:path";
import * as z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BaseProvider } from "../base.js";
import type { ProviderDescriptor } from "../types.js";
import type { ProviderConfig } from "../../runtime/types.js";
import { AppError, NotFoundError, ValidationError } from "../../misc/error.js";

const json = (s: z.ZodTypeAny): import("../types.js").SchemaObject =>
  zodToJsonSchema(s, { target: "openAi" }) as import("../types.js").SchemaObject;

const listDocsSchema = z.object({});
const readStructureSchema = z.object({
  topic: z.string(),
  files_too: z.boolean().optional().default(false).describe("show files, not just directories"),
});
const readFileSchema = z.object({
  topic: z.string().describe('e.g. "react"'),
  file_path: z.string().describe('path inside the topic folder, e.g. "reactive-components/buttons.md"'),
});
const searchBase = {
  query: z.string(),
  topic: z.string(),
  subpath: z.string().optional().describe("restrict the search to a subfolder"),
  allow_large_output: z.enum(["head", "tail", "all"]).optional(),
};
const searchSchema = z.object(searchBase);
const searchRegexSchema = z.object({ ...searchBase, regex: z.string() });

const MAX_DEFAULT_OUTPUT = 10_000; // chars
const MAX_CONTRACT_OUTPUT = 262_144;
const listDocsResultSchema = z.object({ docs: z.array(z.string().min(1).max(512)).max(4096) });
const textResultSchema = z.object({
  structure: z.string().max(MAX_CONTRACT_OUTPUT),
});
const contentResultSchema = z.object({ content: z.string().max(MAX_CONTRACT_OUTPUT) });
const searchResultSchema = z.object({ results: z.string().max(MAX_CONTRACT_OUTPUT) });

export class DocsProvider extends BaseProvider {
  readonly providerDescriptor: ProviderDescriptor = {
    name: "docs",
    description: "Read-only access to documentation folders organized by topic.",
    options: [
      {
        name: "list_docs",
        description: "List available doc topics.",
        kwargsSchema: json(listDocsSchema),
        returnSchema: json(listDocsResultSchema),
      },
      {
        name: "read_structure",
        description: "Tree view of a topic's folder.",
        kwargsSchema: json(readStructureSchema),
        returnSchema: json(textResultSchema),
      },
      {
        name: "read_file",
        description: "Read one doc file.",
        kwargsSchema: json(readFileSchema),
        returnSchema: json(contentResultSchema),
      },
      {
        name: "search",
        description: "Case-insensitive grep in a topic.",
        kwargsSchema: json(searchSchema),
        returnSchema: json(searchResultSchema),
      },
      {
        name: "search_regex",
        description: "Regex search in a topic.",
        kwargsSchema: json(searchRegexSchema),
        returnSchema: json(searchResultSchema),
      },
    ],
    additionalConfig: {
      type: "object",
      properties: {
        docsFolder: { type: "string", default: "docs/", description: "root folder containing topic subfolders" },
        maxOutputSize: { type: "number", default: MAX_DEFAULT_OUTPUT, description: "output size considered too big" },
      },
    },
  };

  private docsRoot!: string;
  private maxOutput = MAX_DEFAULT_OUTPUT;

  async setConfig(newConfig: ProviderConfig): Promise<void> {
    this.config = newConfig;
    this.docsRoot = path.resolve(this.setting<string>("docsFolder", "docs/"));
    this.maxOutput = this.setting<number>("maxOutputSize", MAX_DEFAULT_OUTPUT);
    await fs.mkdir(this.docsRoot, { recursive: true });
    this.emit("reload");
  }

  private validateTopic(topic: string): string {
    if (topic.includes("..") || path.isAbsolute(topic)) throw new ValidationError(`bad topic: ${topic}`);
    return path.join(this.docsRoot, topic);
  }

  private async safeFilePath(topic: string, filePath: string): Promise<string> {
    const base = this.validateTopic(topic);
    if (path.isAbsolute(filePath)) throw new ValidationError("absolute paths not allowed");
    // disallow any ".." component
    if (filePath.split(path.sep).includes("..")) throw new ValidationError('".." not allowed');
    const p = path.resolve(base, filePath);
    if (!p.startsWith(base + path.sep)) throw new ValidationError(`path escapes topic: ${filePath}`);
    return p;
  }

  private guardOutput(s: string, allow?: "head" | "tail" | "all"): string {
    if (s.length <= this.maxOutput || allow === "all") return s;
    const hint = `

[OUTPUT TOO LARGE (${s.length} chars > ${this.maxOutput}). Re-run with allow_large_output set to head/tail/all if you are sure you need it.]`;
    if (allow === "tail") return s.slice(-this.maxOutput) + hint;
    return s.slice(0, this.maxOutput) + hint;
  }

  async callFunctionality(functionality: string, kwargs: unknown): Promise<unknown> {
    if (!this.isFunctionalityActive(functionality)) {
      throw new AppError(`functionality "${functionality}" is not active`, "functionality_inactive");
    }
    switch (functionality) {
      case "list_docs": {
        const entries = await fs.readdir(this.docsRoot, { withFileTypes: true });
        return { docs: entries.filter((e) => e.isDirectory()).map((e) => e.name) };
      }
      case "read_structure": {
        const k = readStructureSchema.parse(kwargs);
        const base = this.validateTopic(k.topic);
        try {
          await fs.access(base);
        } catch {
          throw new NotFoundError(`topic "${k.topic}"`);
        }
        const lines: string[] = [];
        await this.walkStructure(base, "", k.files_too, lines);
        return { structure: this.guardOutput(lines.join("\n")) };
      }
      case "read_file": {
        const k = readFileSchema.parse(kwargs);
        const p = await this.safeFilePath(k.topic, k.file_path);
        let content: string;
        try {
          content = await fs.readFile(p, "utf8");
        } catch {
          throw new NotFoundError(`file ${k.topic}/${k.file_path}`);
        }
        return { content: this.guardOutput(content) };
      }
      case "search":
      case "search_regex": {
        const isRegex = functionality === "search_regex";
        const k = isRegex ? searchRegexSchema.parse(kwargs) : searchSchema.parse(kwargs);
        const base = this.validateTopic(k.topic);
        const dir = k.subpath ? path.resolve(base, k.subpath) : base;
        if (!dir.startsWith(base + path.sep) && dir !== base) throw new ValidationError("bad subpath");
        try {
          await fs.access(dir);
        } catch {
          throw new NotFoundError(`${k.topic}${k.subpath ? "/" + k.subpath : ""}`);
        }
        const results: string[] = [];
        const timeoutMs = 5000;
        if (isRegex) {
          const { matchLinesWithTimeout } = await import("../../misc/regex-worker.js");
          await this.walkFiles(dir, async (rel, content) => {
            const matches = await matchLinesWithTimeout(
              (k as z.infer<typeof searchRegexSchema>).regex,
              "i",
              content,
              timeoutMs,
            );
            for (const [ln, line] of matches) results.push(`${rel}:${ln}: ${line.slice(0, 500)}`);
          });
        } else {
          const needle = k.query.toLowerCase();
          await this.walkGrep(dir, dir, (l) => l.toLowerCase().includes(needle), results);
        }
        return { results: this.guardOutput(results.join("\n"), k.allow_large_output) };
      }
      default:
        throw new AppError(`unknown functionality "${functionality}"`, "unknown_functionality");
    }
  }

  private async walkFiles(
    abs: string,
    fn: (rel: string, content: string) => Promise<void>,
    base?: string,
  ): Promise<void> {
    const root = base ?? abs;
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(abs, e.name);
      if (e.isDirectory()) {
        await this.walkFiles(full, fn, root);
      } else if (e.isFile()) {
        let content: string;
        try {
          content = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
        await fn(path.relative(root, full), content);
      }
    }
  }

  private async walkStructure(abs: string, rel: string, filesToo: boolean, out: string[]): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out.push(r + "/");
        await this.walkStructure(path.join(abs, e.name), r, filesToo, out);
      } else if (filesToo && e.isFile()) {
        out.push(r);
      }
    }
  }

  private async walkGrep(rootAbs: string, abs: string, match: (line: string) => boolean, out: string[]): Promise<void> {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(abs, e.name);
      if (e.isDirectory()) {
        await this.walkGrep(rootAbs, full, match, out);
      } else if (e.isFile()) {
        let content: string;
        try {
          content = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
        content.split("\n").forEach((line, i) => {
          if (match(line)) {
            const rel = path.relative(rootAbs, full);
            out.push(`${rel}:${i + 1}: ${line.slice(0, 500)}`);
          }
        });
      }
    }
  }
}
