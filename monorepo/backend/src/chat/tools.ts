// chat/tools.ts — AI-facing tool registry, documentation, and dispatch.
//
// Tools are grouped: a "tool" (e.g. files, shell, memory) owns one or more
// callable functions. Each group has an md folder (src/prompts/tools/<name>/)
// containing tool.md (generic description) and one <function>.md per function.
//
// The AI context only ever carries the generic descriptions plus the
// `read_tool_info` function. Calling read_tool_info(tools:[...]) loads a
// group's full docs + schemas into the conversation; groups can also be
// pre-loaded by the user (chat settings.loadedTools).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../misc/error.js";
import { z } from "zod";
import { readRuntimeLimits } from "../config/runtime-limits.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_DOCS_DIR = join(HERE, "..", "prompts", "tools");

export interface ToolSetting {
  /** registry GROUP name */
  tool: string;
  /** require explicit user approval before each invocation */
  requiresApproval?: boolean;
  /** ms to wait for approval before denying; 0 = wait forever */
  approvalTimeoutMs?: number;
  /** extra kwargs merged into every call of the group's functions */
  settings?: Record<string, unknown>;
}

/** Effective tool configuration for a chat. */
export interface ToolConfig {
  tools: ToolSetting[];
  /** machine-local prompt overrides pushed by the FE; frontend groups only */
  promptOverrides?: Record<string, string>;
}

export interface ToolFunctionDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** provider dispatch (provider-flavored groups) */
  functionality?: string;
}

export interface ToolGroupDef {
  name: string;
  /**
   * How the group appears to the AI. Backend-executed groups are prefixed
   * "backend_" (seldom used, opt-in); unprefixed names are the genuinely
   * local frontend implementations.
   */
  aiName?: string;
  /** true = executed by backend providers; schemas get the backend_ prefix */
  backend?: boolean;
  flavor: "provider" | "frontend";
  provider?: string;
  functions: ToolFunctionDef[];
}

/** The name the AI sees for a group's function schemas / context headings. */
export function aiGroupName(def: ToolGroupDef): string {
  return def.aiName ?? def.name;
}

/** The AI-facing name of a function (backend groups get the backend_ prefix). */
export function aiFunctionName(def: ToolGroupDef, fn: ToolFunctionDef): string {
  return def.backend ? `backend_${fn.name}` : fn.name;
}

/** Translate admin/UI function names to provider-internal functionality ids. */
export function providerFunctionalities(groupName: string, selected: string[]): string[] {
  const def = TOOL_GROUPS[groupName];
  if (!def) return selected;
  const all = def.functions.flatMap((fn) => (fn.functionality ? [fn.functionality] : []));
  if (selected.includes("*")) return [...new Set(all)];
  return [
    ...new Set(
      selected.flatMap((name) => {
        const fn = def.functions.find(
          (candidate) =>
            candidate.name === name || aiFunctionName(def, candidate) === name || candidate.functionality === name,
        );
        return fn?.functionality ? [fn.functionality] : [];
      }),
    ),
  ];
}

export const TOOL_GROUPS: Record<string, ToolGroupDef> = {
  admin_setup: {
    name: "admin_setup",
    aiName: "setup",
    flavor: "provider",
    provider: "admin-setup",
    functions: [
      {
        name: "setup_list_sections",
        description: "List configuration sections.",
        parameters: { type: "object", properties: {}, required: [] },
        functionality: "list_sections",
      },
      {
        name: "setup_read_section",
        description: "Read a secret-redacted section.",
        parameters: { type: "object", properties: { section: { type: "string" } }, required: ["section"] },
        functionality: "read_section",
      },
      {
        name: "setup_get_options",
        description: "List valid options for a section.",
        parameters: { type: "object", properties: { section: { type: "string" } }, required: ["section"] },
        functionality: "get_options",
      },
      {
        name: "setup_propose_patch",
        description: "Stage a complete configuration for human review. Never applies it.",
        parameters: { type: "object", properties: { config: { type: "object" } }, required: ["config"] },
        functionality: "propose_patch",
      },
      {
        name: "setup_validate_patch",
        description: "Validate and live-test a staged proposal.",
        parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        functionality: "validate_patch",
      },
    ],
  },
  // ----- backend variants: executed by backend providers, never by the FE -----
  files: {
    name: "files",
    backend: true,
    aiName: "backend_files",
    flavor: "provider",
    provider: "files",
    functions: [
      {
        name: "read_file",
        description: "Read a sandboxed file as UTF-8 text or base64.",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            show_line_numbers: { type: "boolean", description: "prefix UTF-8 text lines with 1-based numbers" },
            encoding: { type: "string", enum: ["utf8", "base64"], description: "base64 for binary files" },
          },
          required: ["filename"],
        },
        functionality: "read_file",
      },
      {
        name: "create_file",
        description: "Create or overwrite a sandboxed file from UTF-8 text or base64.",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            content: { type: "string" },
            encoding: { type: "string", enum: ["utf8", "base64"], description: "base64 for binary files" },
          },
          required: ["filename", "content"],
        },
        functionality: "create_file",
      },
      {
        name: "edit_file",
        description: "Replace an exact unique block inside a sandboxed file.",
        parameters: {
          type: "object",
          properties: { filename: { type: "string" }, before: { type: "string" }, after: { type: "string" } },
          required: ["filename", "before", "after"],
        },
        functionality: "edit_file",
      },
      {
        name: "search_and_replace",
        description: "Regex search & replace across a sandboxed file.",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            pattern: { type: "string", description: "JS-flavored regex pattern string" },
            substitution: { type: "string", description: "replacement, supports $1 for capture groups" },
          },
          required: ["filename", "pattern", "substitution"],
        },
        functionality: "search_and_replace",
      },
      {
        name: "edit_lines",
        description: "Replace a 1-indexed inclusive line range with new text.",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            replace_line_start: { type: "number" },
            replace_line_end: { type: "number" },
            text: { type: "string" },
          },
          required: ["filename", "replace_line_start", "replace_line_end", "text"],
        },
        functionality: "edit_lines",
      },
    ],
  },
  shell: {
    name: "shell",
    backend: true,
    aiName: "backend_shell",
    flavor: "provider",
    provider: "shell",
    functions: [
      {
        name: "shell_exec",
        description:
          "Run a shell command inside the sandboxed container. Subject to the chat's safety policy (may require user approval).",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        functionality: "shell_oneshot",
      },
    ],
  },
  // ----- frontend variants: executed genuinely locally by the connected FE -----
  fe_files: {
    name: "fe_files",
    aiName: "files",
    flavor: "frontend",
    functions: [
      {
        name: "read_file",
        description: "Read a file from the local sandboxed folder as UTF-8 text or base64.",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            show_line_numbers: { type: "boolean", description: "prefix UTF-8 text lines with 1-based numbers" },
            encoding: { type: "string", enum: ["utf8", "base64"], description: "base64 for binary files" },
          },
          required: ["filename"],
        },
      },
      {
        name: "create_file",
        description: "Create or overwrite a local sandboxed file from UTF-8 text or base64.",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            content: { type: "string" },
            encoding: { type: "string", enum: ["utf8", "base64"], description: "base64 for binary files" },
          },
          required: ["filename", "content"],
        },
      },
      {
        name: "edit_file",
        description: "Replace an exact unique block inside a local file.",
        parameters: {
          type: "object",
          properties: { filename: { type: "string" }, before: { type: "string" }, after: { type: "string" } },
          required: ["filename", "before", "after"],
        },
      },
      {
        name: "search_and_replace",
        description: "Regex search & replace across a local file.",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            pattern: { type: "string", description: "JS-flavored regex pattern string" },
            substitution: { type: "string", description: "replacement, supports $1 for capture groups" },
          },
          required: ["filename", "pattern", "substitution"],
        },
      },
      {
        name: "edit_lines",
        description: "Replace a 1-indexed inclusive line range with new text in a local file.",
        parameters: {
          type: "object",
          properties: {
            filename: { type: "string" },
            replace_line_start: { type: "number" },
            replace_line_end: { type: "number" },
            text: { type: "string" },
          },
          required: ["filename", "replace_line_start", "replace_line_end", "text"],
        },
      },
    ],
  },
  fe_shell: {
    name: "fe_shell",
    aiName: "shell",
    flavor: "frontend",
    functions: [
      {
        name: "shell_exec",
        description:
          "Run a shell command on the local machine, subject to the chat's safety policy (may require user approval).",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    ],
  },
  fe_docs: {
    name: "fe_docs",
    aiName: "docs",
    flavor: "frontend",
    functions: [
      {
        name: "docs_list",
        description: "List available doc topics.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "docs_structure",
        description: "Tree view of a topic's folder.",
        parameters: {
          type: "object",
          properties: { topic: { type: "string" }, files_too: { type: "boolean" } },
          required: ["topic"],
        },
      },
      {
        name: "docs_read",
        description: "Read one doc file inside a topic.",
        parameters: {
          type: "object",
          properties: { topic: { type: "string" }, file_path: { type: "string" } },
          required: ["topic", "file_path"],
        },
      },
      {
        name: "docs_search",
        description: "Case-insensitive text search within a doc topic.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            topic: { type: "string" },
            subpath: { type: "string" },
            allow_large_output: { type: "string", enum: ["head", "tail", "all"] },
          },
          required: ["query", "topic"],
        },
      },
      {
        name: "docs_search_regex",
        description: "Regex search within a doc topic.",
        parameters: {
          type: "object",
          properties: {
            regex: { type: "string" },
            topic: { type: "string" },
            subpath: { type: "string" },
            allow_large_output: { type: "string", enum: ["head", "tail", "all"] },
          },
          required: ["regex", "topic"],
        },
      },
    ],
  },
  memory: {
    name: "memory",
    flavor: "provider",
    provider: "memory",
    functions: [
      {
        name: "list_keywords",
        description: "List all memory keywords of one type in this chat.",
        parameters: {
          type: "object",
          properties: { type: { type: "string", enum: ["agent", "behavior", "self", "routine"] } },
          required: ["type"],
        },
        functionality: "list_keywords",
      },
      {
        name: "list_memories",
        description: "Recall memories of one type matching any of the given keywords.",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["agent", "behavior", "self", "routine"] },
            keywords: { type: "array", items: { type: "string" } },
          },
          required: ["type", "keywords"],
        },
        functionality: "list_memories",
      },
      {
        name: "add_memory",
        description: "Store a new memory (type, keyword, content, private flag).",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["agent", "behavior", "self", "routine"] },
            keywords: { type: "array", items: { type: "string" }, description: "one or more short retrieval keys" },
            content: { type: "string" },
            isPrivate: { type: "boolean" },
          },
          required: ["type", "keywords", "content", "isPrivate"],
        },
        functionality: "add_memory",
      },
      {
        name: "remove_memory",
        description: "Delete one memory by id.",
        parameters: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        functionality: "remove_memory",
      },
    ],
  },
  tts: {
    name: "tts",
    flavor: "provider",
    provider: "tts",
    functions: [
      {
        name: "synthesize_speech",
        description: "Generate speech and immediately play it on connected users' devices.",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "text to speak" },
            language: { type: "string", description: "language name or Auto" },
            voice: { type: "string", description: "service-supported speaker name" },
            voiceRef: {
              type: "string",
              description:
                "WAV path inside the files folder to clone; absolute or relative Docker paths are normalized",
            },
            referenceText: { type: "string", description: "transcript of voiceRef when required by the model" },
            instruct: { type: "string", description: "optional delivery/style instruction" },
          },
          required: ["text"],
        },
        functionality: "synthesize",
      },
    ],
  },
  docs: {
    name: "docs",
    backend: true,
    flavor: "provider",
    provider: "docs",
    // AI-facing names are prefixed to avoid clashing with the files group
    functions: [
      {
        name: "docs_list",
        description: "List available doc topics.",
        parameters: { type: "object", properties: {}, required: [] },
        functionality: "list_docs",
      },
      {
        name: "docs_structure",
        description: "Tree view of a topic's folder.",
        parameters: {
          type: "object",
          properties: { topic: { type: "string" }, files_too: { type: "boolean" } },
          required: ["topic"],
        },
        functionality: "read_structure",
      },
      {
        name: "docs_read",
        description: "Read one doc file inside a topic.",
        parameters: {
          type: "object",
          properties: { topic: { type: "string" }, file_path: { type: "string" } },
          required: ["topic", "file_path"],
        },
        functionality: "read_file",
      },
      {
        name: "docs_search",
        description: "Case-insensitive text search within a doc topic (optionally a subfolder).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            topic: { type: "string" },
            subpath: { type: "string" },
            allow_large_output: { type: "string", enum: ["head", "tail", "all"] },
          },
          required: ["query", "topic"],
        },
        functionality: "search",
      },
      {
        name: "docs_search_regex",
        description: "Regex search within a doc topic (optionally a subfolder).",
        parameters: {
          type: "object",
          properties: {
            regex: { type: "string" },
            topic: { type: "string" },
            subpath: { type: "string" },
            allow_large_output: { type: "string", enum: ["head", "tail", "all"] },
          },
          required: ["regex", "topic"],
        },
        functionality: "search_regex",
      },
    ],
  },
  fe_audio: {
    name: "fe_audio",
    aiName: "audio",
    flavor: "frontend",
    functions: [
      {
        name: "audio_devices",
        description: "List available audio input/output devices on the user's machine.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "audio_play",
        description:
          "Play audio from a sandboxed file, chat attachment, or trusted transient handle; blocks until finished.",
        parameters: {
          type: "object",
          properties: {
            source: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["file", "attachment", "handle"] },
                path: { type: "string" },
                filename: { type: "string" },
                handle: { type: "string" },
              },
              required: ["kind"],
            },
            device: { type: "string" },
          },
          required: ["source"],
        },
      },
      {
        name: "audio_read",
        description: "Record a WAV into the active files sandbox and return its filename.",
        parameters: {
          type: "object",
          properties: { seconds: { type: "number" }, device: { type: "string" }, send_to_model: { type: "boolean" } },
          required: ["seconds"],
        },
      },
    ],
  },
  fe_edit_settings: {
    name: "fe_edit_settings",
    aiName: "edit_settings",
    flavor: "frontend",
    functions: [
      {
        name: "edit_settings",
        description:
          "Ask a human user to open their local tool settings. Use only for local files, shell, docs, or audio; server-side TTS and backend tools require the admin plane.",
        parameters: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              enum: ["files", "shell", "docs", "audio"],
              description: "local tool group to configure",
            },
            reason: { type: "string", description: "short explanation shown to the user" },
            settings: {
              type: "object",
              description:
                'specific proposed settings, such as {rootFolders:["/home/me/Desktop"]} or {workingFolder:"/home/me/project", mode:"docker_readonly"}',
              additionalProperties: true,
            },
            target_user: { type: "string", description: "human name; required when multiple humans are eligible" },
          },
          required: ["tool", "reason", "settings"],
        },
      },
    ],
  },
  read_tool_info: {
    name: "read_tool_info",
    flavor: "provider",
    // special-cased in the chat loop; never dispatched through a provider
    functions: [
      {
        name: "read_tool_info",
        description:
          "Load additional tools into this conversation: pass tool names and their documentation + functions become available for the rest of the chat.",
        parameters: {
          type: "object",
          properties: { tools: { type: "array", items: { type: "string" } } },
          required: ["tools"],
        },
      },
    ],
  },
};

/** Groups that are always available to the AI (schemas + generic doc). */
export const ALWAYS_LOADED_GROUPS = ["read_tool_info", "memory", "fe_edit_settings"];

export const DEFAULT_TIMEOUT_MS = 120_000;

// ---------- md documentation ----------

/** Process-local documentation cache; entries are derived from prompt overrides. */
export const TOOL_DOC_CACHE_MAX_ENTRIES = 256;
const docCache = new Map<string, { tool: string; functions: Record<string, string> }>();
const latestOverrideKey = new Map<string, string>();

/**
 * Load a group's md docs: { tool: tool.md content, functions: {<fn>.md: content} }.
 * `override` replaces the tool.md content (FE overrides for frontend groups).
 */
export function loadToolDocs(
  group: string,
  overrides?: Record<string, string>,
): { tool: string; functions: Record<string, string> } {
  const def = TOOL_GROUPS[group];
  const groupOverride = overrides?.[group];
  const key = `${group}|${JSON.stringify(overrides ?? {})}`;
  if (overrides !== undefined) {
    const previous = latestOverrideKey.get(group);
    if (previous && previous !== key) docCache.delete(previous);
    latestOverrideKey.set(group, key);
  }
  const hit = docCache.get(key);
  if (hit) return hit;

  const out = { tool: groupOverride ?? "", functions: {} as Record<string, string> };
  if (def) {
    try {
      // Frontend groups use internal keys such as fe_files, but share the
      // canonical prompt folder named after their AI-facing tool (files).
      const promptFolder = group.startsWith("fe_") ? aiGroupName(def) : group;
      const dir = join(TOOL_DOCS_DIR, promptFolder);
      if (!out.tool) {
        try {
          out.tool = readFileSync(join(dir, "tool.md"), "utf8").trim();
        } catch {
          out.tool = "";
        }
      }
      for (const fn of def.functions) {
        try {
          out.functions[fn.name] =
            overrides?.[`${group}:${fn.name}`] ?? readFileSync(join(dir, `${fn.name}.md`), "utf8").trim();
        } catch {
          out.functions[fn.name] = overrides?.[`${group}:${fn.name}`] ?? "";
        }
      }
    } catch {
      /* missing folder entirely */
    }
  }
  docCache.set(key, out);
  while (docCache.size > TOOL_DOC_CACHE_MAX_ENTRIES) {
    const oldest = docCache.keys().next().value;
    if (typeof oldest !== "string") break;
    docCache.delete(oldest);
  }
  return out;
}

/** Invalidate the doc cache (used by tests / prompt hot-reload later). */
export function clearToolDocCache(): void {
  docCache.clear();
  latestOverrideKey.clear();
}

/** Deterministic cache size probe for lifecycle/performance contract tests. */
export function toolDocCacheSize(): number {
  return docCache.size;
}

/** List md folders present under prompts/tools (for CLI/tests). */
export function listToolDocFolders(): string[] {
  try {
    return readdirSync(TOOL_DOCS_DIR).filter((f) => !f.includes("."));
  } catch {
    return [];
  }
}

// ---------- OpenAI schema building ----------

function groupFunctionsSchemas(groupName: string): unknown[] {
  const def = TOOL_GROUPS[groupName];
  if (!def) return [];
  return def.functions.map((fn) => {
    let parameters = fn.parameters;
    if (def.flavor === "frontend" && def.name !== "fe_edit_settings") {
      const properties = (parameters.properties ?? {}) as Record<string, unknown>;
      parameters = {
        ...parameters,
        properties: {
          ...properties,
          target_user: {
            type: "string",
            description:
              "human whose configured local machine should run this; required when multiple humans are eligible",
          },
        },
      };
    }
    return {
      type: "function",
      function: { name: aiFunctionName(def, fn), description: fn.description, parameters },
    };
  });
}

/**
 * Build OpenAI-style tools for the currently loaded groups.
 * read_tool_info is ALWAYS included so the AI can load more tools itself.
 */
export function buildOpenAiTools(config: ToolConfig | null): unknown[] {
  const loaded = new Set([...(config?.tools.map((t) => t.tool) ?? []), ...ALWAYS_LOADED_GROUPS]);
  const out: unknown[] = [];
  const names = new Set<string>();
  for (const g of loaded) {
    for (const schema of groupFunctionsSchemas(g)) {
      const name = (schema as { function?: { name?: string } }).function?.name;
      if (name && !names.has(name)) {
        names.add(name);
        out.push(schema);
      }
    }
  }
  return out;
}

export interface ToolCallRequest {
  name: string;
  arguments: string;
  setting: ToolSetting | null;
  groupDef: ToolGroupDef;
  fnDef: ToolFunctionDef;
}

/** Keep provider-supplied tool arguments bounded before parsing or dispatch. */
export const MAX_TOOL_ARGUMENT_BYTES = 64 * 1024;

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (typeof raw !== "string") {
    throw new Error("invalid tool arguments JSON");
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  const limits = readRuntimeLimits();
  if (bytes > limits.toolArgumentBytes) {
    throw new Error(`tool arguments JSON exceeds ${limits.toolArgumentBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new Error("invalid tool arguments JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("tool arguments JSON must be an object");
  }
  let fields = 0;
  const inspect = (value: unknown, depth: number): void => {
    if (depth > limits.toolArgumentDepth) throw new Error("tool arguments JSON is too deeply nested");
    if (Array.isArray(value)) return value.forEach((entry) => inspect(entry, depth + 1));
    if (!value || typeof value !== "object") return;
    for (const [name, entry] of Object.entries(value)) {
      if (name === "__proto__" || name === "prototype" || name === "constructor")
        throw new Error("unsafe tool argument key");
      if (++fields > limits.toolArgumentFields) throw new Error("tool arguments JSON has too many fields");
      inspect(entry, depth + 1);
    }
  };
  inspect(parsed, 0);
  const result = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!result.success) throw new Error("tool arguments JSON must be an object");
  return result.data;
}

function findGroupByFunction(name: string): { group: ToolGroupDef; fn: ToolFunctionDef } | null {
  for (const g of Object.values(TOOL_GROUPS)) {
    const fn = g.functions.find((f) => aiFunctionName(g, f) === name);
    if (fn) return { group: g, fn };
  }
  return null;
}

/** The group-level ToolSetting governing a function call (null when unloaded). */
export function settingForFunction(config: ToolConfig | null, functionName: string): ToolSetting | null {
  const hit = findGroupByFunction(functionName);
  if (!hit) return null;
  return config?.tools.find((s) => s.tool === hit.group.name) ?? null;
}

/** Parse raw model tool calls against the active config. Unknown/unloaded tools are skipped with a warning. */
export function parseToolCalls(
  raw: { name: string; arguments: string }[],
  config: ToolConfig | null,
): ToolCallRequest[] {
  const out: ToolCallRequest[] = [];
  for (const call of raw) {
    const hit = findGroupByFunction(call.name);
    if (!hit) {
      continue; // not one of the provider tools available in this chat
    }
    if (!ALWAYS_LOADED_GROUPS.includes(hit.group.name) && !settingForFunction(config, call.name)) {
      continue; // group exists but is not loaded
    }
    out.push({
      name: call.name,
      arguments: call.arguments,
      setting: settingForFunction(config, call.name),
      groupDef: hit.group,
      fnDef: hit.fn,
    });
  }
  return out;
}

/** Execute a provider-flavored tool through the kernel.
 *  opts.chatId is injected into kwargs so chat-scoped providers (memory) work;
 *  opts.userId enables private-memory storage when the caller is that user. */
export async function executeProviderTool(
  req: ToolCallRequest,
  opts: { chatId: string; userId?: string } = { chatId: "" },
): Promise<unknown> {
  if (req.groupDef.flavor !== "provider" || !req.groupDef.provider || !req.fnDef.functionality) {
    throw new Error(`tool "${req.name}" is not provider-executable`);
  }
  const kwargs = parseToolArguments(req.arguments);
  if (!opts.chatId) throw new Error("executeProviderTool requires a chatId");
  // Chat/user context is an internal memory-provider invariant. Other
  // provider schemas are intentionally closed, so injecting these fields
  // would make otherwise valid file/tool calls fail their descriptor gate.
  const injected: Record<string, unknown> = { ...kwargs };
  if (req.groupDef.provider === "memory") {
    injected.chatId = opts.chatId;
    if (opts.userId) injected.ownerUserId = opts.userId;
  } else if (req.groupDef.provider === "tts") {
    // Chat context is transport metadata, not an argument the model should
    // need to invent. It is required for transient audio ownership/events.
    injected.chatId = opts.chatId;
  }
  const { kernel } = await import("../runtime/kernel.js");
  const { getConfig } = await import("../runtime/config-parser.js");
  const providerConfig = (await getConfig(undefined, req.groupDef.provider))[req.groupDef.provider];
  const explicitlyAllowed = providerConfig?.additionalSettings.aiAllowedFunctionalities;
  const allowedRaw = Array.isArray(explicitlyAllowed)
    ? explicitlyAllowed.map(String)
    : (providerConfig?.activeFunctionalities ?? []);
  const allowed = providerFunctionalities(req.groupDef.name, allowedRaw);
  if (!allowed.includes(req.fnDef.functionality)) {
    throw new AppError(`AI access to ${req.groupDef.provider}.${req.fnDef.functionality} is disabled`, "tool_disabled");
  }
  return kernel.useProvider(req.groupDef.provider, req.fnDef.functionality, {
    ...(req.setting?.settings ?? {}),
    ...injected,
  });
}
