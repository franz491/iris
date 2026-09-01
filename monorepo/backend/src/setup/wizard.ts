import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataFile } from "../db/sqlite.js";
import { spawnSync } from "node:child_process";
import { readSetupSettings, writeSetupSettings, localIpv4Addresses, type SetupSettings } from "./settings.js";
import { listModels, listRouters, routeCompletionOnce } from "../model-router/model-manager.js";
import { setApiKey } from "../model-router/keys.js";
import { getConfig, setConfig } from "../runtime/config-parser.js";
import type { ProviderConfig } from "../runtime/types.js";
import { resolvePrompt } from "../prompts/library.js";
import { setPrompt } from "../prompts/prompts.js";
import { auth, findUserByName, validateCredential } from "../api/auth.js";
import { z } from "zod";

type ModelChoice = SetupSettings["defaultModel"];

const SYSTEM_PROMPTS = ["groupChat", "noReply", "importantInfo"] as const;
const MEMORY_FUNCTIONS = ["list_keywords", "list_memories", "add_memory", "remove_memory"];
const TOOL_SPECS = [
  {
    name: "files",
    description: "server-side files restricted to one folder",
    functions: ["read_file", "create_file", "edit_file", "search_and_replace", "edit_lines"],
    folderKey: "rootFolder",
    folderDefault: "files/",
  },
  {
    name: "docs",
    description: "read-only server documentation library",
    functions: ["list_docs", "read_structure", "read_file", "search", "search_regex"],
    folderKey: "docsFolder",
    folderDefault: "docs/",
  },
  {
    name: "shell",
    description: "Docker-isolated shell with one mounted folder",
    functions: ["shell_oneshot"],
    folderKey: "rootFolder",
    folderDefault: "shell/",
  },
  {
    name: "search",
    description: "server-side web search",
    functions: ["search"],
  },
  {
    name: "tts",
    description: "audio.cpp-compatible text-to-speech HTTP service",
    functions: ["synthesize"],
  },
] as const;

const SETUP_SECTION_COUNT = 5;
const setupProgressSchema = z
  .object({
    nextSection: z.number().int().min(0).max(SETUP_SECTION_COUNT),
  })
  .strict();

class Wizard {
  private readonly rl = createInterface({ input, output, terminal: Boolean(input.isTTY), crlfDelay: Infinity });
  private closing = false;
  private aborted = false;

  constructor() {
    this.rl.on("SIGINT", () => {
      this.aborted = true;
      this.rl.close();
    });
    this.rl.on("close", () => {
      if (!this.closing) this.aborted = true;
    });
  }

  close(): void {
    this.closing = true;
    this.rl.close();
  }

  private ensureOpen(): void {
    if (this.aborted) throw new Error("setup aborted");
  }

  async text(question: string, fallback?: string): Promise<string> {
    const hint = fallback === undefined ? "" : ` [${fallback}]`;
    this.ensureOpen();
    const answer = (await this.rl.question(`${question}${hint}: `)).trim();
    this.ensureOpen();
    return answer || fallback || "";
  }

  async secret(question: string): Promise<string> {
    this.ensureOpen();
    if (!input.isTTY) return this.text(question);
    output.write(`${question}: `);
    const tty = spawnSync("stty", ["-echo"], { input: undefined, stdio: ["inherit", "ignore", "ignore"] });
    try {
      const answer = (await this.rl.question("")).trim();
      output.write("\n");
      this.ensureOpen();
      return answer;
    } finally {
      if (!tty.error) spawnSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
    }
  }

  async yes(question: string, fallback = true): Promise<boolean> {
    const answer = (await this.rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"}: `)).trim().toLowerCase();
    if (!answer) return fallback;
    return answer === "y" || answer === "yes";
  }

  async select(question: string, choices: string[], fallback = 0): Promise<number> {
    output.write(`\n${question}\n`);
    choices.forEach((choice, index) =>
      output.write(`  ${index + 1}. ${choice}${index === fallback ? " (default)" : ""}\n`),
    );
    while (true) {
      const answer = await this.text("Choose", String(fallback + 1));
      const index = Number(answer) - 1;
      if (Number.isInteger(index) && index >= 0 && index < choices.length) return index;
      output.write("Enter one of the listed numbers.\n");
    }
  }

  async multi(question: string, choices: string[], defaults: string[] = []): Promise<string[]> {
    output.write(`\n${question}\n`);
    choices.forEach((choice, index) => output.write(`  ${index + 1}. ${choice}\n`));
    const defaultNumbers = defaults
      .map((item) => choices.indexOf(item) + 1)
      .filter((n) => n > 0)
      .join(",");
    const answer = await this.text("Numbers separated by commas; 'all' or 'none'", defaultNumbers || "none");
    if (answer.toLowerCase() === "all") return [...choices];
    if (answer.toLowerCase() === "none") return [];
    return [
      ...new Set(
        answer
          .split(",")
          .map((part) => Number(part.trim()) - 1)
          .filter((index) => Number.isInteger(index) && index >= 0 && index < choices.length)
          .map((index) => choices[index]),
      ),
    ];
  }
}

export async function runSetupWizard(): Promise<void> {
  const w = new Wizard();
  let settings = readSetupSettings();
  const settingsPath = dataFile("setup.json");
  const progressPath = path.resolve(path.dirname(settingsPath), "setup-progress.json");
  const nextSection = readSetupProgress(progressPath);
  const checkpoint = (section: number) => writeSetupProgress(progressPath, section);
  output.write("\nIris interactive setup\nChanges are saved after each section; rerun `setup` any time.\n");
  writeSetupSettings(settings);
  try {
    if (nextSection <= 0) {
      settings = await configureServer(w, settings);
      writeSetupSettings(settings);
      checkpoint(1);
    }
    if (nextSection <= 1) {
      settings = await configureDefaultModel(w, settings);
      writeSetupSettings(settings);
      checkpoint(2);
    }
    if (nextSection <= 2) {
      await configureFirstUser(w);
      checkpoint(3);
    }
    if (nextSection <= 3) {
      await configureTools(w);
      checkpoint(4);
    }
    if (nextSection <= 4) {
      await configurePrompts(w, settings.defaultModel);
      checkpoint(5);
    }
    if (existsSync(progressPath)) unlinkSync(progressPath);
    output.write(`\nSetup complete. Settings: ${path.relative(process.cwd(), settingsPath)}\n`);
    output.write(`Provider bootstrap YAML (optional): ${path.resolve(path.dirname(settingsPath), "config.yaml")}\n`);
    if (settings.defaultModel.apiRouter === "openai-compat") {
      output.write(
        `Named API keys are stored in: ${path.resolve(path.dirname(settingsPath), "keys.db")} (use \`key set\` to update them)\n`,
      );
    }
    output.write(`Prompt overrides are stored in: ${path.resolve(path.dirname(settingsPath), "prompts.db")}\n`);
    output.write("Restart the Iris backend to apply server, origin, and authentication changes.\n");
  } catch (error) {
    writeSetupSettings(settings);
    if (String(error).includes("setup aborted") || (error instanceof Error && error.name === "AbortError")) {
      output.write(`\nSetup cancelled. Temporary settings were saved to ${settingsPath}.\n`);
      output.write(`Setup progress was saved to ${progressPath}; rerun the command to continue.\n`);
      return;
    }
    throw error;
  } finally {
    w.close();
  }
}

export function readSetupProgress(progressPath: string): number {
  if (!existsSync(progressPath)) return 0;
  try {
    const parsed = setupProgressSchema.safeParse(JSON.parse(readFileSync(progressPath, "utf8")));
    return parsed.success ? parsed.data.nextSection : 0;
  } catch {
    return 0;
  }
}

export function writeSetupProgress(progressPath: string, nextSection: number): void {
  const temporaryPath = `${progressPath}.tmp-${process.pid}-${randomUUID()}`;
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fileDescriptor, JSON.stringify({ nextSection }, null, 2) + "\n", "utf8");
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = undefined;
    renameSync(temporaryPath, progressPath);
  } catch (error) {
    if (fileDescriptor !== undefined) closeSync(fileDescriptor);
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

async function configureServer(w: Wizard, settings: SetupSettings): Promise<SetupSettings> {
  if (!(await w.yes("Configure server access and allowed frontend origins?", true))) return settings;
  const ips = localIpv4Addresses();
  const networkLabel = ips.length
    ? `everyone on this network (${ips.map((ip) => ip.split(".").slice(0, 3).join(".") + ".*").join(", ")})`
    : "everyone on this network (no private IPv4 detected; custom entry required)";
  const mode = await w.select("Who may connect to this backend?", [
    "this machine only",
    networkLabel,
    "custom settings",
  ]);
  const port = Number(await w.text("Backend port", String(settings.server.port))) || 3000;
  const localOrigins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
  ];
  if (mode === 0) {
    settings.server = { host: "127.0.0.1", port, publicUrl: `http://localhost:${port}`, trustedOrigins: localOrigins };
  } else if (mode === 1 && ips.length > 0) {
    const ip = ips[0];
    const prefix = ip.split(".").slice(0, 3).join(".");
    settings.server = {
      host: "0.0.0.0",
      port,
      publicUrl: `http://${ip}:${port}`,
      trustedOrigins: [...localOrigins, `http://${prefix}.*:*`, `https://${prefix}.*:*`],
    };
  } else {
    const host = await w.text("Bind host", settings.server.host);
    const publicUrl = await w.text("Public backend URL", settings.server.publicUrl);
    const origins = await w.text(
      "Allowed frontend origins/patterns, comma separated",
      settings.server.trustedOrigins.join(","),
    );
    settings.server = {
      host,
      port,
      publicUrl,
      trustedOrigins: origins
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    };
  }
  output.write(`Allowed origins: ${settings.server.trustedOrigins.join(", ")}\n`);
  return settings;
}

async function configureDefaultModel(w: Wizard, settings: SetupSettings): Promise<SetupSettings> {
  if (!(await w.yes("Configure the default model/provider?", true))) return settings;
  const routerNames = listRouters();
  const currentRouter = Math.max(0, routerNames.indexOf(settings.defaultModel.apiRouter));
  const router = routerNames[await w.select("Default model provider", routerNames, currentRouter)];
  if (router === "llamacpp") {
    settings.modelProviders.llamacppBaseUrl = await w.text(
      "llama.cpp base URL",
      settings.modelProviders.llamacppBaseUrl,
    );
  } else {
    settings.modelProviders.openAiCompatBaseUrl = await w.text(
      "OpenAI-compatible base URL",
      settings.modelProviders.openAiCompatBaseUrl,
    );
  }
  // Save the endpoint before discovery because the router reads this file.
  writeSetupSettings(settings);
  const models = await listModels(router);
  let model: string;
  let maxContext: number;
  if (models.length > 0) {
    const manualIndex = models.length;
    const index = await w.select("Default model", [
      ...models.map((m) => `${m.id}${m.contextWindow ? ` (${m.contextWindow} ctx)` : ""}`),
      "enter manually",
    ]);
    if (index === manualIndex) {
      model = await w.text("Model ID", settings.defaultModel.model);
      maxContext = Number(await w.text("Context window", String(settings.defaultModel.maxContext))) || 8192;
    } else {
      model = models[index].id;
      maxContext =
        models[index].contextWindow ??
        (Number(await w.text("Context window", String(settings.defaultModel.maxContext))) || 8192);
    }
  } else {
    output.write("No models were discovered; the server may be offline or may not expose /models.\n");
    model = await w.text("Model ID", settings.defaultModel.model);
    maxContext = Number(await w.text("Context window", String(settings.defaultModel.maxContext))) || 8192;
  }
  let apiKeyName = settings.defaultModel.apiKeyName;
  if (router === "openai-compat" && (await w.yes("Store a named API key for this default?", false))) {
    apiKeyName = await w.text("Key name", apiKeyName ?? "openai");
    const keyFile = await w.text("Read secret key from file (leave blank to keep existing)");
    if (keyFile) setApiKey(apiKeyName, readFileSync(keyFile, "utf8").replace(/\r?\n$/, ""));
  }
  settings.defaultModel = { apiRouter: router, model, maxContext, apiKeyName };
  return settings;
}

async function configureFirstUser(w: Wizard): Promise<void> {
  if (!(await w.yes("Create a user now?", false))) return;
  const name = await w.text("Username");
  if (!name) return;
  if (findUserByName(name)) {
    output.write(`User ${name} already exists; skipped.\n`);
    return;
  }
  const mode = await w.select(
    "How should the credential be supplied?",
    ["type it now (hidden)", "read it from a file"],
    0,
  );
  let credential: string;
  if (mode === 0) {
    credential = await w.secret("Password or PIN");
  } else {
    const file = await w.text("Credential file (recommended mode 0600)");
    if (!file) {
      output.write("No credential supplied; skipped user creation. Use `user add` later.\n");
      return;
    }
    credential = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  }
  validateCredential(credential, /^\d{4,6}$/.test(credential));
  await auth.api.signUpEmail({ body: { email: `${name}@iris.local`, password: credential, name } });
  output.write(`Created user ${name}.\n`);
}

async function configureTools(w: Wizard): Promise<void> {
  if (!(await w.yes("Configure backend tool permissions?", true))) return;
  const existing = await getConfig();
  const configs: ProviderConfig[] = [];
  for (const spec of TOOL_SPECS) {
    output.write(`\n${spec.name}: ${spec.description}\n`);
    const current = existing[spec.name];
    const allowed = await w.multi(
      `AI-allowed ${spec.name} functions`,
      [...spec.functions],
      Array.isArray(current?.additionalSettings.aiAllowedFunctionalities)
        ? current.additionalSettings.aiAllowedFunctionalities.map(String)
        : (current?.activeFunctionalities ?? []),
    );
    const additionalSettings: Record<string, unknown> = {
      ...(current?.additionalSettings ?? {}),
      aiAllowedFunctionalities: allowed,
    };
    if ("folderKey" in spec) {
      additionalSettings[spec.folderKey] = await w.text(
        "Allowed folder",
        String(additionalSettings[spec.folderKey] ?? spec.folderDefault),
      );
    }
    if (spec.name === "shell") {
      additionalSettings.dockerExecutable = await w.text(
        "Docker-compatible executable",
        String(additionalSettings.dockerExecutable ?? "docker"),
      );
      additionalSettings.dockerImage = await w.text(
        "Container image",
        String(additionalSettings.dockerImage ?? "alpine:latest"),
      );
    }
    if (spec.name === "tts") {
      additionalSettings.baseUrl = await w.text(
        "audio.cpp service URL",
        String(additionalSettings.baseUrl ?? "http://127.0.0.1:8100"),
      );
      additionalSettings.model = await w.text("audio.cpp model ID", String(additionalSettings.model ?? "pocket-tts"));
      additionalSettings.timeoutMs = Number(
        await w.text("TTS timeout in milliseconds", String(additionalSettings.timeoutMs ?? 120000)),
      );
    }
    const internallyRequired = spec.name === "files" ? ["read_file", "create_file"] : [];
    configs.push({
      name: spec.name,
      activeFunctionalities: [...new Set([...internallyRequired, ...allowed])],
      additionalSettings,
    });
  }
  configs.push({ name: "memory", activeFunctionalities: MEMORY_FUNCTIONS, additionalSettings: {} });
  for (const config of configs) await setConfig(config.name, config);
}

async function configurePrompts(w: Wizard, defaultModel: ModelChoice): Promise<void> {
  if (!(await w.yes("Review the system prompts?", true))) return;
  let aiEditor: ModelChoice | null = null;
  if (await w.yes("Offer AI-assisted rewriting while reviewing?", false)) {
    aiEditor = await chooseEditingModel(w, defaultModel);
  }
  for (const key of SYSTEM_PROMPTS) {
    const current = (await resolvePrompt(key)) ?? "";
    output.write(`\n--- ${key} ---\n${current}\n--- end ---\n`);
    const choices = ["keep", "edit in $EDITOR", ...(aiEditor ? ["ask AI to rewrite"] : [])];
    const action = await w.select(`Action for ${key}`, choices);
    if (action === 1) {
      const edited = editExternally(key, current);
      if (edited !== null && edited.trim() !== current.trim()) await setPrompt(key, edited.trim());
    } else if (action === 2 && aiEditor) {
      const instruction = await w.text(
        "What should the AI improve?",
        "Make it clear, compact, and reliable for a small model; preserve its behavior",
      );
      const result = await routeCompletionOnce(
        {
          model: aiEditor.model,
          apiRouter: aiEditor.apiRouter,
          apiAdditionalFields: {},
          apiKeyName: aiEditor.apiKeyName,
        },
        [
          {
            role: "system",
            content:
              "Edit the supplied system prompt. Return only the replacement prompt, with no fences or commentary.",
          },
          { role: "user", content: `Instruction: ${instruction}\n\nPrompt:\n${current}` },
        ],
      );
      output.write(`\nProposed ${key}:\n${result.content}\n`);
      if (await w.yes("Use this replacement?", false)) await setPrompt(key, result.content.trim());
    }
  }
}

async function chooseEditingModel(w: Wizard, fallback: ModelChoice): Promise<ModelChoice> {
  if (await w.yes(`Use the default model (${fallback.apiRouter}/${fallback.model})?`, true)) return fallback;
  const routers = listRouters();
  const router = routers[await w.select("Prompt-editing provider", routers)];
  const models = await listModels(router);
  const model = models.length
    ? models[
        await w.select(
          "Prompt-editing model",
          models.map((m) => m.id),
        )
      ].id
    : await w.text("Prompt-editing model ID");
  const context = models.find((m) => m.id === model)?.contextWindow ?? fallback.maxContext;
  let apiKeyName = router === fallback.apiRouter ? fallback.apiKeyName : undefined;
  if (router === "openai-compat") {
    apiKeyName = (await w.text("Named API key to use (blank if none)", apiKeyName ?? "")) || undefined;
  }
  return { apiRouter: router, model, maxContext: context, apiKeyName };
}

function editExternally(key: string, content: string): string | null {
  const dir = mkdtempSync(path.join(tmpdir(), "iris-prompt-"));
  const file = path.join(dir, `${key}.md`);
  try {
    writeFileSync(file, content + "\n", "utf8");
    const editor = process.env.EDITOR || process.env.VISUAL || (process.env.EDITOR = "nano");
    const result = spawnSync(editor, [file], { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      output.write(`Editor failed; retrying with nano.\n`);
      const fallback = spawnSync("nano", [file], { stdio: "inherit" });
      if (fallback.error || fallback.status !== 0) return null;
    }
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
