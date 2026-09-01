// tests/prompts.test.ts — prompt library resolution + export/import.
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiFunctionName,
  clearToolDocCache,
  loadToolDocs,
  TOOL_DOC_CACHE_MAX_ENTRIES,
  toolDocCacheSize,
  TOOL_GROUPS,
} from "../src/chat/tools.js";

process.env.IRIS_DATA_DIR = mkdtempSync(join(tmpdir(), "iris-prompts-test-"));
const resolvePrompt = async (key: string) => (await import("../src/prompts/library.js")).resolvePrompt(key);
const exportPrompts = async () => (await import("../src/prompts/transfer.js")).exportPrompts();
const importPrompts = async (raw: string) => (await import("../src/prompts/transfer.js")).importPrompts(raw);

beforeAll(async () => {
  const { migratePromptsDb } = await import("../src/prompts/prompts.js");
  migratePromptsDb();
});

describe("prompt library", () => {
  it("lists tool prompts separately and resolves nested tool files", async () => {
    const { listPromptKeys } = await import("../src/prompts/library.js");
    const keys = listPromptKeys();
    expect(keys).toContainEqual({ key: "tool:files:read_file", group: "tool" });
    expect(keys).toContainEqual({ key: "tool:shell", group: "tool" });
    expect(await resolvePrompt("tool:files:read_file")).toBeTruthy();
    expect(keys.filter((x) => x.group === "tool").length).toBeGreaterThan(10);
  });
  it("gives every function prompt an example call", async () => {
    const { listPromptKeys } = await import("../src/prompts/library.js");
    for (const item of listPromptKeys().filter((x) => x.group === "tool" && x.key.split(":").length > 2)) {
      expect(await resolvePrompt(item.key), item.key).toMatch(/example/i);
    }
  });
  it("falls back to the built-in default md", async () => {
    const v = await resolvePrompt("importantInfo");
    expect(v).toBeTruthy();
    expect(v!).toContain("reply itself");
  });

  it("keeps base output, group routing, and optional silence in separate defaults", async () => {
    expect(await resolvePrompt("importantInfo")).toContain("Memory");
    expect(await resolvePrompt("groupChat")).toContain("@name");
    expect(await resolvePrompt("groupChat")).not.toContain("<no-reply>");
    expect(await resolvePrompt("noReply")).toContain("<no-reply>");
  });

  it("bounds and clears the built-in prompt cache", async () => {
    const { listPromptKeys, clearBuiltinPromptCache, builtinPromptCacheSize, BUILTIN_PROMPT_CACHE_MAX_ENTRIES } =
      await import("../src/prompts/library.js");
    clearBuiltinPromptCache();
    for (const { key } of listPromptKeys()) await resolvePrompt(key);
    expect(builtinPromptCacheSize()).toBeLessThanOrEqual(BUILTIN_PROMPT_CACHE_MAX_ENTRIES);
    expect(builtinPromptCacheSize()).toBeGreaterThan(0);
    clearBuiltinPromptCache();
    expect(builtinPromptCacheSize()).toBe(0);
  });
});

describe("tool prompts", () => {
  it("bounds, invalidates, and clears the owned documentation cache", () => {
    clearToolDocCache();
    for (let i = 0; i < TOOL_DOC_CACHE_MAX_ENTRIES + 8; i++) loadToolDocs(`synthetic-${i}`);
    expect(toolDocCacheSize()).toBe(TOOL_DOC_CACHE_MAX_ENTRIES);

    const first = loadToolDocs("memory", { memory: "first override" });
    expect(first.tool).toBe("first override");
    expect(toolDocCacheSize()).toBe(TOOL_DOC_CACHE_MAX_ENTRIES);
    const second = loadToolDocs("memory", { memory: "second override" });
    expect(second.tool).toBe("second override");
    expect(toolDocCacheSize()).toBe(TOOL_DOC_CACHE_MAX_ENTRIES);

    clearToolDocCache();
    expect(toolDocCacheSize()).toBe(0);
  });

  it("loads canonical docs for frontend tool groups", () => {
    expect(loadToolDocs("fe_files").functions.edit_file).toContain("Example");
    expect(loadToolDocs("fe_audio").functions.audio_read).toContain("permission");
  });

  it("loads non-empty generic and function docs for every tool group", () => {
    for (const [name, group] of Object.entries(TOOL_GROUPS)) {
      const docs = loadToolDocs(name);
      expect(docs.tool, `${name} tool.md`).toBeTruthy();
      for (const fn of group.functions) {
        expect(docs.functions[fn.name], `${name}/${fn.name}.md`).toBeTruthy();
      }
    }
  });

  it("contains valid JSON in every json example fence", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const root = join(here, "../src/prompts");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".md")) files.push(p);
      }
    };
    walk(root);
    for (const file of files) {
      for (const match of readFileSync(file, "utf8").matchAll(/```json\s*([\s\S]*?)```/g)) {
        expect(() => JSON.parse(match[1]), file).not.toThrow();
      }
    }
  });

  it("keeps always-on memory function names unprefixed", () => {
    const memory = TOOL_GROUPS.memory;
    expect(aiFunctionName(memory, memory.functions[0])).toBe("list_keywords");
  });

  it("exposes documented file options and correct backend prefixes", async () => {
    const { buildOpenAiTools } = await import("../src/chat/tools.js");
    const schemas = buildOpenAiTools({ tools: [{ tool: "files" }, { tool: "fe_files" }] }) as {
      function: { name: string; parameters: { properties?: Record<string, unknown> } };
    }[];
    const backendRead = schemas.find((s) => s.function.name === "backend_read_file")!;
    const localRead = schemas.find((s) => s.function.name === "read_file")!;
    for (const schema of [backendRead, localRead]) {
      expect(schema.function.parameters.properties).toHaveProperty("show_line_numbers");
      expect(schema.function.parameters.properties).toHaveProperty("encoding");
    }
    expect(schemas.some((s) => s.function.name === "list_keywords")).toBe(true);
    expect(schemas.some((s) => s.function.name === "backend_list_keywords")).toBe(false);
  });
});

describe("prompt transfer", () => {
  it("round-trips an export/import of global overrides", async () => {
    const payload = {
      kind: "iris.prompts",
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      prompts: { noReply: "TEST_OVERRIDE_VALUE" },
    };
    const n = await importPrompts(JSON.stringify(payload));
    expect(n).toBe(1);
    expect(await resolvePrompt("noReply")).toBe("TEST_OVERRIDE_VALUE");
    const out = await exportPrompts();
    expect(out.prompts.noReply).toBe("TEST_OVERRIDE_VALUE");
    // cleanup: remove the override so other tests see defaults
    const { deletePrompt } = await import("../src/prompts/prompts.js");
    await deletePrompt("noReply");
    expect(await resolvePrompt("noReply")).not.toBe("TEST_OVERRIDE_VALUE");
  });

  it("rejects foreign payloads", async () => {
    await expect(importPrompts('{"kind":"other"}')).rejects.toThrow(/iris\.prompts/);
  });

  it("rejects malformed metadata and prompt collections", async () => {
    const base = { kind: "iris.prompts", version: 1, exportedAt: new Date().toISOString(), prompts: {} };
    await expect(importPrompts(JSON.stringify({ ...base, version: 2 }))).rejects.toThrow(/iris\.prompts/);
    await expect(importPrompts(JSON.stringify({ ...base, exportedAt: "not-a-date" }))).rejects.toThrow(/iris\.prompts/);
    await expect(importPrompts(JSON.stringify({ ...base, prompts: [] }))).rejects.toThrow(/iris\.prompts/);
    await expect(importPrompts(JSON.stringify({ ...base, prompts: { noReply: 42 } }))).rejects.toThrow(/invalid value/);
  });

  it("validates the complete import before applying any overrides", async () => {
    await expect(
      importPrompts(
        JSON.stringify({
          kind: "iris.prompts",
          version: 1,
          exportedAt: new Date().toISOString(),
          prompts: { importantInfo: "APPLIED", noReply: 42 },
        }),
      ),
    ).rejects.toThrow(/invalid value/);
    expect(await resolvePrompt("importantInfo")).not.toBe("APPLIED");
  });

  it("rejects oversized prompt imports", async () => {
    await expect(
      importPrompts(
        JSON.stringify({
          kind: "iris.prompts",
          version: 1,
          exportedAt: new Date().toISOString(),
          prompts: { noReply: "x".repeat(256 * 1024 + 1) },
        }),
      ),
    ).rejects.toThrow(/byte limit/);
  });
});
