// lib/tools.ts — per-machine/per-chat tool configuration (localStorage) +
// the client-side executor interface (Tauri later, browser stub now).
import { apiUrl } from "./backend";

export interface ToolSetting {
  tool: string;
  requiresApproval?: boolean;
  approvalTimeoutMs?: number;
  settings?: Record<string, unknown>;
}

export interface ToolConfig {
  /** tool GROUP names with their approval settings */
  tools: ToolSetting[];
  /** machine-local doc overrides for FRONTEND tools (edited in the modal) */
  promptOverrides?: Record<string, string>;
}

/** Base localStorage key for frontend-tool prompt overrides. */
const PROMPT_OVERRIDES_KEY = "iris.toolPrompts";
const CLIENT_ID_KEY = "iris.clientId";

export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function getPromptOverrides(userId = "guest"): Record<string, string> {
  return readJson(`${PROMPT_OVERRIDES_KEY}.${userId}`, isPromptOverrides) ?? {};
}

export function setPromptOverride(key: string, doc: string, userId = "guest"): void {
  const all = getPromptOverrides(userId);
  if (doc.trim()) all[key] = doc;
  else delete all[key];
  writeJson(`${PROMPT_OVERRIDES_KEY}.${userId}`, all);
}

/** Offline fallback mirror of the AI-facing tool groups. */
export const KNOWN_TOOLS: {
  name: string;
  flavor: "provider" | "frontend";
  alwaysLoaded?: boolean;
  editable?: boolean;
  toolDoc: string;
  functions: Record<string, { doc: string; parameters?: unknown }>;
}[] = [
  {
    name: "fe_files",
    flavor: "frontend",
    toolDoc: "Local file access in the sandboxed folder.",
    functions: {
      read_file: { doc: "Read a local sandboxed text file." },
      create_file: { doc: "Create/overwrite a local sandboxed file." },
      edit_file: { doc: "Replace a block inside a local file." },
      search_and_replace: { doc: "Regex search & replace in a local file." },
      edit_lines: { doc: "Replace a line range in a local file." },
    },
  },
  {
    name: "fe_shell",
    flavor: "frontend",
    toolDoc: "Run shell commands locally, subject to the safety policy.",
    functions: { shell_exec: { doc: "Run one shell command locally." } },
  },
  {
    name: "fe_docs",
    flavor: "frontend",
    toolDoc: "Read documentation from the local docs/ folder.",
    functions: {
      docs_list: { doc: "List doc topics." },
      docs_structure: { doc: "Tree view of a topic." },
      docs_read: { doc: "Read one doc file." },
      docs_search: { doc: "Search within a topic." },
      docs_search_regex: { doc: "Regex search within a topic." },
    },
  },
  {
    name: "files",
    flavor: "provider",
    toolDoc: "Server-side sandboxed file access. Prefer local versions unless explicitly asked for the backend one.",
    functions: {},
  },
  {
    name: "shell",
    flavor: "provider",
    toolDoc: "Server-side shell commands. Prefer local versions unless explicitly asked for the backend one.",
    functions: {},
  },
  {
    name: "docs",
    flavor: "provider",
    toolDoc: "Documentation stored on the server. Prefer local versions unless explicitly asked for the backend one.",
    functions: {},
  },
  {
    name: "fe_audio",
    flavor: "frontend",
    toolDoc: "Local audio devices. Requires the local files tool for playback and recordings.",
    functions: {
      audio_devices: { doc: "List available audio devices." },
      audio_play: { doc: "Play a WAV from a file, attachment, or trusted handle (blocks until done)." },
      audio_read: { doc: "Record N seconds from the microphone to a WAV file; returns its filename." },
    },
  },
  {
    name: "fe_edit_settings",
    flavor: "frontend",
    toolDoc: "Ask a human to open local tool settings when setup is needed.",
    functions: { edit_settings: { doc: "Open local tool settings after explicit user approval." } },
  },
  {
    name: "read_tool_info",
    flavor: "provider",
    alwaysLoaded: true,
    toolDoc: "Tool discovery: load more tools into the chat on demand.",
    functions: { read_tool_info: { doc: "Load additional tools into this conversation." } },
  },
];

const DEFAULTS_KEY = "iris.tools.defaults.";
const CHAT_PREFIX = "iris.tools.chat.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPromptOverrides(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function isToolSetting(value: unknown): value is ToolSetting {
  if (!isRecord(value) || typeof value.tool !== "string") return false;
  if ("requiresApproval" in value && typeof value.requiresApproval !== "boolean") return false;
  if (
    "approvalTimeoutMs" in value &&
    (typeof value.approvalTimeoutMs !== "number" || !Number.isFinite(value.approvalTimeoutMs))
  )
    return false;
  return !("settings" in value) || isRecord(value.settings);
}

function isToolConfig(value: unknown): value is ToolConfig {
  return (
    isRecord(value) &&
    Array.isArray(value.tools) &&
    value.tools.every(isToolSetting) &&
    (!("promptOverrides" in value) || isPromptOverrides(value.promptOverrides))
  );
}

function readJson<T>(key: string, isValid: (value: unknown) => value is T): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return isValid(value) ? value : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

function defaultConfig(): ToolConfig {
  return { tools: [{ tool: "fe_edit_settings", requiresApproval: true }] };
}

export function getMachineDefaults(userId: string): ToolConfig {
  return readJson(DEFAULTS_KEY + userId, isToolConfig) ?? defaultConfig();
}

export function setMachineDefaults(userId: string, cfg: ToolConfig): void {
  writeJson(DEFAULTS_KEY + userId, cfg);
}

function chatKey(chatId: string, userId: string): string {
  return `${CHAT_PREFIX}${userId}.${chatId}`;
}

export function getChatOverride(chatId: string, userId: string): ToolConfig | null {
  return readJson(chatKey(chatId, userId), isToolConfig);
}

export function setChatOverride(chatId: string, userId: string, cfg: ToolConfig | null): void {
  if (cfg === null) localStorage.removeItem(chatKey(chatId, userId));
  else writeJson(chatKey(chatId, userId), cfg);
}

/**
 * Effective config is ALWAYS per-chat (stored in localStorage under the chat id).
 * Machine defaults remain available as a starting template for new chats.
 */
export function effectiveToolConfig(chatId: string | null, userId: string): ToolConfig {
  if (chatId) {
    return getChatOverride(chatId, userId) ?? getMachineDefaults(userId);
  }
  return getMachineDefaults(userId);
}

/** Only execution-ready local tools are advertised to the backend. */
export function advertisedToolConfig(chatId: string | null, userId: string): ToolConfig {
  const cfg = effectiveToolConfig(chatId, userId);
  return {
    ...cfg,
    promptOverrides: getPromptOverrides(userId),
    tools: cfg.tools.filter((setting) => {
      if (!IS_TAURI && setting.tool !== "fe_edit_settings") return false;
      if (setting.tool === "fe_files" || setting.tool === "fe_docs") {
        return Boolean(String(setting.settings?.rootFolder ?? "").trim());
      }
      if (setting.tool === "fe_shell") {
        return Boolean(String(setting.settings?.workingFolder ?? "").trim());
      }
      return setting.tool.startsWith("fe_");
    }),
  };
}

/** Seed a chat's config from the machine defaults (used on first open). */
export function seedChatFromDefaults(chatId: string, userId: string): ToolConfig {
  const existing = getChatOverride(chatId, userId);
  if (!existing) setChatOverride(chatId, userId, getMachineDefaults(userId));
  return getChatOverride(chatId, userId) ?? defaultConfig();
}

const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function isDesktopClient(): boolean {
  return IS_TAURI;
}

/** Invoke a Tauri command; dynamic import keeps the browser bundle clean. */
async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * Client-side tool executor.
 * - Inside Tauri: shell/file tools execute natively (safety modes + jailed FS).
 * - In the browser: web_search proxies through the backend (CORS); native-only
 *   tools are unavailable.
 */
export async function executeClientTool(
  tool: string,
  args: Record<string, unknown>,
  setting?: ToolSetting,
): Promise<unknown> {
  if (!IS_TAURI) {
    throw new Error(`tool "${tool}" requires the Iris desktop app (frontend tools run genuinely locally)`);
  }
  switch (tool) {
    // ---- shell (local) ----
    case "shell_exec": {
      const mode = String(setting?.settings?.mode ?? "docker_readonly");
      const workingFolder = String(setting?.settings?.workingFolder ?? "").trim();
      if (!workingFolder) throw new Error("shell needs a working folder; open tool settings to configure it");
      const result = await tauriInvoke<{ code: number; stdout: string; stderr: string; cwd?: string }>(
        "tool_shell_oneshot",
        { command: String(args.command ?? ""), mode, workingFolder },
      );
      return { ...result, cwd: result.cwd ?? workingFolder };
    }
    // ---- files (local, jailed folder) ----
    case "read_file": {
      const encoding = args.encoding === "base64" ? "base64" : "utf8";
      let content = await tauriInvoke<string>("tool_file_read", {
        root: requiredFolder(setting, "files"),
        filename: String(args.filename ?? ""),
        encoding,
      });
      if (encoding === "utf8" && args.show_line_numbers === true) {
        content = content
          .split("\n")
          .map((line, i) => `${i + 1}: ${line}`)
          .join("\n");
      }
      return { content, encoding };
    }
    case "create_file": {
      const encoding = args.encoding === "base64" ? "base64" : "utf8";
      await tauriInvoke("tool_file_write", {
        root: requiredFolder(setting, "files"),
        filename: String(args.filename ?? ""),
        content: String(args.content ?? ""),
        encoding,
      });
      return { ok: true };
    }
    case "edit_file": {
      const filename = String(args.filename ?? "");
      const before = String(args.before ?? "");
      const after = String(args.after ?? "");
      const root = requiredFolder(setting, "files");
      const text = await tauriInvoke<string>("tool_file_read", { root, filename, encoding: "utf8" });
      const count = text.split(before).length - 1;
      if (count === 0) throw new Error(`"${before}" not found in ${filename}`);
      if (count > 1)
        throw new Error(`"before" block matches ${count} times in ${filename}; provide a wider unique block`);
      await tauriInvoke("tool_file_write", { root, filename, content: text.replace(before, after), encoding: "utf8" });
      return { ok: true };
    }
    case "search_and_replace": {
      const filename = String(args.filename ?? "");
      const pattern = String(args.pattern ?? "");
      const substitution = String(args.substitution ?? "");
      const root = requiredFolder(setting, "files");
      const text = await tauriInvoke<string>("tool_file_read", { root, filename, encoding: "utf8" });
      let re: RegExp;
      try {
        re = new RegExp(pattern, "gm");
      } catch (e) {
        throw new Error(`invalid regex: ${e instanceof Error ? e.message : pattern}`);
      }
      await tauriInvoke("tool_file_write", {
        root,
        filename,
        content: text.replace(re, substitution),
        encoding: "utf8",
      });
      return { ok: true };
    }
    case "edit_lines": {
      const filename = String(args.filename ?? "");
      const start = Number(args.replace_line_start ?? 1);
      const end = Number(args.replace_line_end ?? 1);
      const text = String(args.text ?? "");
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error("replace_line_start/end must be integers with end >= start");
      }
      const root = requiredFolder(setting, "files");
      const content = await tauriInvoke<string>("tool_file_read", { root, filename, encoding: "utf8" });
      const lines = content.split("\n");
      lines.splice(start - 1, end - start + 1, ...text.split("\n"));
      await tauriInvoke("tool_file_write", { root, filename, content: lines.join("\n"), encoding: "utf8" });
      return { ok: true };
    }
    // ---- audio (local devices, via cpal) ----
    case "audio_devices":
      return await tauriInvoke("tool_audio_devices", {});
    case "audio_play": {
      const source = (args.source ?? {}) as Record<string, unknown>;
      let wavBase64 = "";
      if (source.kind === "file")
        wavBase64 = await tauriInvoke<string>("tool_file_read", {
          root: requiredFolder(setting, "audio"),
          filename: String(source.path ?? ""),
          encoding: "base64",
        });
      else {
        const chatId = String(args._chatId ?? "");
        const url =
          source.kind === "handle"
            ? `${apiUrl("/api")}/audio/${encodeURIComponent(String(source.handle ?? ""))}`
            : `${apiUrl("/api")}/files/chats/${encodeURIComponent(chatId)}/${encodeURIComponent(String(source.filename ?? ""))}`;
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) throw new Error(`audio source unavailable (${response.status})`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        wavBase64 = btoa(binary);
      }
      return await tauriInvoke("tool_audio_play", {
        wavBase64,
        device: args.device ? String(args.device) : null,
      });
    }
    case "audio_read": {
      const b64 = await tauriInvoke<string>("tool_audio_read", {
        seconds: Number(args.seconds ?? 5),
        device: args.device ? String(args.device) : null,
      });
      return { wav_base64: b64 };
    }
    // ---- docs (local docs/ root on this machine) ----
    case "docs_list":
      return await tauriInvoke("tool_docs_list", { root: requiredFolder(setting, "docs") });
    case "docs_structure":
      return await tauriInvoke("tool_docs_structure", {
        root: requiredFolder(setting, "docs"),
        topic: String(args.topic ?? ""),
        filesToo: Boolean(args.files_too ?? false),
      });
    case "docs_read":
      return await tauriInvoke("tool_docs_read", {
        root: requiredFolder(setting, "docs"),
        topic: String(args.topic ?? ""),
        filePath: String(args.file_path ?? ""),
      });
    case "docs_search":
      return await tauriInvoke("tool_docs_search", {
        rootFolder: requiredFolder(setting, "docs"),
        query: String(args.query ?? ""),
        topic: String(args.topic ?? ""),
        subpath: args.subpath ? String(args.subpath) : null,
        allowLargeOutput: args.allow_large_output ? String(args.allow_large_output) : null,
        regex: null,
      });
    case "docs_search_regex":
      return await tauriInvoke("tool_docs_search", {
        rootFolder: requiredFolder(setting, "docs"),
        query: null,
        topic: String(args.topic ?? ""),
        subpath: args.subpath ? String(args.subpath) : null,
        allowLargeOutput: args.allow_large_output ? String(args.allow_large_output) : null,
        regex: String(args.regex ?? ""),
      });
    default:
      throw new Error(`tool "${tool}" is not implemented by this client`);
  }
}

function requiredFolder(setting: ToolSetting | undefined, label: string): string {
  const configured = setting?.settings?.rootFolders;
  const folder = Array.isArray(configured)
    ? String(configured[0] ?? "").trim()
    : String(setting?.settings?.rootFolder ?? "").trim();
  if (!folder) throw new Error(`${label} needs an allowed folder; open tool settings to configure it`);
  return folder;
}

/** Tool group entry as served by GET /api/tools?chatId=... */
export interface ToolCatalogEntry {
  name: string;
  /** AI-facing name (backend_ prefixed for server-executed groups) */
  aiName?: string;
  backend?: boolean;
  flavor: "provider" | "frontend";
  alwaysLoaded: boolean;
  editable: boolean;
  toolDoc: string;
  functions: Record<string, { doc: string; parameters: unknown }>;
  loaded?: boolean;
}

function isToolCatalogResponse(value: unknown): value is { groups: ToolCatalogEntry[] } {
  if (!value || typeof value !== "object" || !Array.isArray((value as { groups?: unknown }).groups)) return false;
  return (value as { groups: unknown[] }).groups.every((group) => {
    if (!group || typeof group !== "object") return false;
    const item = group as Record<string, unknown>;
    return (
      typeof item.name === "string" &&
      (item.flavor === "provider" || item.flavor === "frontend") &&
      typeof item.alwaysLoaded === "boolean" &&
      typeof item.editable === "boolean" &&
      typeof item.toolDoc === "string" &&
      !!item.functions &&
      typeof item.functions === "object" &&
      Object.values(item.functions as Record<string, unknown>).every(
        (fn) => !!fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).doc === "string",
      )
    );
  });
}

let catalogCache: ToolCatalogEntry[] | null = null;

/** Full tool catalog from the backend; falls back to the local mirror offline. */
export async function fetchToolCatalog(chatId?: string | null): Promise<ToolCatalogEntry[]> {
  if (!chatId && catalogCache) return catalogCache;
  try {
    const res = await fetch(apiUrl(`/api/tools${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ""}`));
    if (res.ok) {
      const data: unknown = await res.json();
      if (isToolCatalogResponse(data)) {
        catalogCache = data.groups;
        return data.groups;
      }
    }
  } catch {
    /* fall through */
  }
  return KNOWN_TOOLS.map(
    (g) =>
      ({
        ...g,
        alwaysLoaded: g.alwaysLoaded ?? false,
        editable: g.editable ?? false,
        loaded: undefined,
      }) as ToolCatalogEntry,
  );
}

/** Persisted per-chat loaded groups live server-side; push them via tool-config. */
export async function setChatLoadedTools(
  chatId: string,
  userId: string,
  clientId: string,
  loaded: string[],
): Promise<void> {
  const cfg = advertisedToolConfig(chatId, userId);
  const res = await fetch(apiUrl(`/api/chats/${chatId}/tool-config`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ ...cfg, clientId, loadedTools: [...new Set(loaded)] }),
  });
  if (!res.ok) throw new Error(`failed to set loaded tools: ${res.status}`);
}
