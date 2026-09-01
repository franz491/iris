<script lang="ts">
  import { onMount } from "svelte";
  import { authClient } from "../lib/api";
  import { apiUrl } from "../lib/backend";
  import { audioInstallPayload, comfyInstallPayload, isImmutableCommit } from "../lib/audio-install";
  import { withRecentAuth } from "../lib/reauth-coordinator";
  import {
    adminRequest,
    getAdminStatus,
    parseAdminPatch,
    type AdminPatch,
    type AdminStatus,
  } from "../lib/admin-client";
  import {
    changeAdminRole,
    createAdminUser,
    deleteAdminUser,
    listAdminUsers,
    resetAdminPassword,
    revokeAdminSessions,
    type AdminUser,
  } from "../lib/admin-users-client";
  type Tab = "overview" | "server" | "services" | "tools" | "prompts" | "speech" | "users" | "models" | "advanced";
  type InstallRequest = Readonly<Record<string, string>>;
  type InstallResult = {
    binary?: string;
    executable?: string;
    argumentsPrefix?: string[];
    workingDirectory?: string;
    status: Record<string, unknown>;
  };
  type InstallEvent =
    { type: "log"; text: string } | { type: "error"; message: string } | { type: "complete"; result: InstallResult };
  type AdminModel = {
    id: string;
    name: string;
    path: string;
    ownership: "external" | "managed";
    sizeBytes: number | null;
    format: string | null;
    createdAt: string;
  };
  type DiscoveryAccelerator = { kind: string; available: boolean; devices: string[]; detail: string };
  type DiscoveryState = {
    os: Record<string, unknown>;
    accelerators: DiscoveryAccelerator[];
    executables: string[];
    modelFiles: string[];
  };
  type ProcessEditor = { arguments?: string[]; environment?: Record<string, string> };
  type ServiceKind = "llm" | "audio" | "tts" | "stt" | "comfyui";
  type ServicePreset = {
    name: string;
    kind: ServiceKind;
    mode: "connect-only" | "start-and-manage" | "connect-or-start";
    endpoint: {
      baseUrl: string;
      healthCheck: { protocol: "openai-model-list" | "audio" | "tts" | "stt" | "comfyui" | "http" };
      startupTimeoutSeconds: number;
    };
    process?: {
      executable: string;
      arguments: string[];
      workingDirectory?: string;
      environment: Record<string, string>;
    };
    audioCpp?: {
      modelId: string;
      family: string;
      modelPath: string;
      task: "tts" | "asr" | "gen" | "clon" | "vc" | "svc" | "s2s";
      mode: "offline" | "streaming";
      backend: "cpu" | "cuda" | "vulkan" | "metal" | "hip" | "best";
      device: number;
      threads: number;
      lazyLoad: boolean;
      defaultVoicePreset?: { voiceRef?: string; referenceText?: string; speaker?: string };
      asrModel?: { modelId: string; family: string; modelPath: string; mode: "offline" | "streaming" };
    };
    shutdownPolicy: "leave-running" | "terminate-owned";
  };
  type ServicePresetCollection = Record<string, ServicePreset | undefined>;
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const isStringRecord = (value: unknown): value is Record<string, string> =>
    isRecord(value) && Object.values(value).every((item) => typeof item === "string");
  const isProcessEditor = (value: unknown): value is ProcessEditor =>
    isRecord(value) &&
    (value.arguments === undefined ||
      (Array.isArray(value.arguments) && value.arguments.every((item) => typeof item === "string"))) &&
    (value.environment === undefined || isStringRecord(value.environment));
  function parseInstallResult(value: unknown): InstallResult {
    if (!isRecord(value) || !isRecord(value.status)) throw new Error("Installation returned an invalid result");
    const optionalString = (key: string) =>
      value[key] === undefined ? undefined : typeof value[key] === "string" ? value[key] : null;
    const binary = optionalString("binary");
    const executable = optionalString("executable");
    const workingDirectory = optionalString("workingDirectory");
    if (binary === null || executable === null || workingDirectory === null)
      return (() => {
        throw new Error("Installation returned an invalid result");
      })();
    const argumentsPrefix = value.argumentsPrefix;
    if (
      argumentsPrefix !== undefined &&
      (!Array.isArray(argumentsPrefix) || argumentsPrefix.some((item) => typeof item !== "string"))
    )
      throw new Error("Installation returned invalid arguments");
    return { binary, executable, workingDirectory, argumentsPrefix, status: value.status };
  }
  function parseInstallEvent(value: unknown): InstallEvent {
    if (!isRecord(value) || typeof value.type !== "string") throw new Error("Installation returned an invalid event");
    if (value.type === "log" && typeof value.text === "string") return { type: "log", text: value.text };
    if (value.type === "error" && typeof value.message === "string") return { type: "error", message: value.message };
    if (value.type === "complete") return { type: "complete", result: parseInstallResult(value.result) };
    throw new Error("Installation returned an invalid event");
  }
  const isAdminModel = (value: unknown): value is AdminModel =>
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    (value.ownership === "external" || value.ownership === "managed") &&
    (value.sizeBytes === null || typeof value.sizeBytes === "number") &&
    (value.format === null || typeof value.format === "string") &&
    typeof value.createdAt === "string";
  function parseAdminModels(value: unknown): AdminModel[] {
    return isRecord(value) && Array.isArray(value.models) && value.models.every(isAdminModel) ? value.models : [];
  }
  const isDiscoveryAccelerator = (value: unknown): value is DiscoveryAccelerator =>
    isRecord(value) &&
    typeof value.kind === "string" &&
    typeof value.available === "boolean" &&
    Array.isArray(value.devices) &&
    value.devices.every((item) => typeof item === "string") &&
    typeof value.detail === "string";
  function parseDiscovery(value: unknown): DiscoveryState {
    if (
      !isRecord(value) ||
      !isRecord(value.os) ||
      !Array.isArray(value.accelerators) ||
      !value.accelerators.every(isDiscoveryAccelerator) ||
      !Array.isArray(value.executables) ||
      !value.executables.every((item) => typeof item === "string") ||
      !Array.isArray(value.modelFiles) ||
      !value.modelFiles.every((item) => typeof item === "string")
    )
      return { os: {}, accelerators: [], executables: [], modelFiles: [] };
    return {
      os: value.os,
      accelerators: value.accelerators,
      executables: value.executables,
      modelFiles: value.modelFiles,
    };
  }
  const isServiceKind = (value: unknown): value is ServiceKind =>
    value === "llm" || value === "audio" || value === "tts" || value === "stt" || value === "comfyui";
  const isServicePreset = (value: unknown): value is ServicePreset =>
    isRecord(value) &&
    typeof value.name === "string" &&
    isServiceKind(value.kind) &&
    isRecord(value.endpoint) &&
    typeof value.endpoint.baseUrl === "string" &&
    isRecord(value.endpoint.healthCheck) &&
    typeof value.endpoint.healthCheck.protocol === "string" &&
    typeof value.endpoint.startupTimeoutSeconds === "number" &&
    typeof value.mode === "string" &&
    isRecord(value.process) &&
    typeof value.process.executable === "string" &&
    Array.isArray(value.process.arguments) &&
    value.process.arguments.every((item) => typeof item === "string") &&
    (value.shutdownPolicy === "leave-running" || value.shutdownPolicy === "terminate-owned");
  function parseServicePresets(value: unknown): ServicePresetCollection {
    if (!isRecord(value) || !isRecord(value.defaults)) return {};
    const presets: ServicePresetCollection = {};
    for (const [key, preset] of Object.entries(value.defaults))
      if (isServiceKind(key) && isServicePreset(preset) && preset.kind === key) presets[key] = preset;
    return presets;
  }
  let tab = $state<Tab>("overview");
  let advancedOpened = $state(false);
  let status = $state<AdminStatus | null>(null);
  let draft = $state<any>(null);
  let error = $state("");
  let notice = $state("");
  let workflowNotice = $state("");
  let workflowBusy = $state(false);
  let serviceFeedback = $state<Record<string, { error: boolean; message: string }>>({});
  let servicePresets = $state<ServicePresetCollection>({});
  let defaultSelections = $state<Record<number, boolean>>({});
  let dirty = $state(false);
  let loading = $state(true);
  let refreshing = $state(false);
  let signingIn = $state(false);
  let patch = $state<AdminPatch | null>(null);
  let services = $state<any>(null);
  let discovery = $state<DiscoveryState | null>(null);
  let software = $state<any>(null);
  let installService = $state<any>(null);
  let installing = $state(false);
  let refreshingRequirements = $state(false);
  let installLog = $state("");
  let pendingInstall = $state<{ backend?: string; revision: string } | null>(null);
  let users = $state<AdminUser[]>([]);
  let models = $state<AdminModel[]>([]);
  let keys = $state<string[]>([]);
  let bootstrap = $state<any>(null);
  let reauthOpen = $state(false);
  let reauthPassword = $state("");
  let reauthError = $state("");
  let reauthBusy = $state(false);
  let reauthResolver: ((ok: boolean) => void) | null = null;
  let reauthInput = $state<HTMLInputElement | null>(null);
  let reauthReturnFocus = $state<HTMLElement | null>(null);
  let promptKeys = $state<Array<{ key: string; group: string }>>([]);
  let bootstrapForm = $state({ token: "", name: "", password: "", passwordConfirmation: "" });
  let signInForm = $state({ name: "", password: "" });
  let userForm = $state({ name: "", email: "", password: "", role: "user" });
  let modelForm = $state({ name: "", path: "", ownership: "external" });
  let keyForm = $state({ name: "", value: "" });
  let promptKey = $state("importantInfo");
  let promptForm = $state({ key: "importantInfo", value: "", origin: "" });
  let advanced = $state("");
  let confirmation = $state<"apply" | "reset" | null>(null);
  let applyController: AbortController | null = null;
  const ttsFamilies = [
    "pocket_tts",
    "qwen3_tts",
    "vibevoice",
    "omnivoice",
    "index_tts2",
    "irodori_tts",
    "miotts",
    "moss_tts_local",
    "moss_tts_nano",
    "neutts",
    "supertonic",
    "voxcpm2",
  ];
  const asrFamilies = [
    "qwen3_asr",
    "citrinet_asr",
    "fun_asr_nano",
    "higgs_audio_stt",
    "hviske_asr",
    "nemotron_asr",
    "vibevoice_asr",
  ];
  const tabs: Tab[] = ["overview", "server", "services", "tools", "prompts", "speech", "users", "models", "advanced"];
  const MAX_ADMIN_CONFIG_JSON_BYTES = 1024 * 1024;
  const cloneFailureMessage =
    "Admin configuration could not be prepared because it is invalid or exceeds the 1 MiB editing limit.";
  function plain<T>(value: T): T | undefined {
    try {
      const serialized = JSON.stringify(value);
      if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_ADMIN_CONFIG_JSON_BYTES)
        return undefined;
      return JSON.parse(serialized) as T;
    } catch {
      return undefined;
    }
  }
  function askReauth(): Promise<boolean> {
    reauthReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    reauthOpen = true;
    reauthPassword = "";
    reauthError = "";
    queueMicrotask(() => reauthInput?.focus());
    return new Promise((resolve) => {
      reauthResolver = resolve;
    });
  }
  function closeReauth(ok: boolean) {
    reauthOpen = false;
    reauthPassword = "";
    const resolve = reauthResolver;
    reauthResolver = null;
    resolve?.(ok);
    queueMicrotask(() => reauthReturnFocus?.focus());
    reauthReturnFocus = null;
  }
  async function submitReauth() {
    if (!reauthPassword || reauthBusy) return;
    reauthBusy = true;
    reauthError = "";
    try {
      const response = await fetch(`${apiUrl("/api")}/admin/reauth`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: reauthPassword }),
      });
      if (!response.ok) {
        reauthError = "Incorrect password. Try again.";
        return;
      }
      // Re-auth is a status-only endpoint; tolerate an empty 2xx body, but
      // reject unexpected non-JSON success payloads before granting access.
      const body = await response.text();
      if (body.trim()) {
        try {
          const parsed: unknown = JSON.parse(body);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("invalid reauth response");
        } catch {
          reauthError = "Reauthentication failed. Try again.";
          return;
        }
      }
      closeReauth(true);
    } catch {
      reauthError = "Reauthentication failed. Try again.";
    } finally {
      reauthBusy = false;
    }
  }
  const request = (path: string, init: RequestInit = {}): Promise<any> => adminRequest(path, init, askReauth);
  async function pickPath(assign: (path: string) => void, directory = false) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory, multiple: false });
      if (typeof selected === "string") {
        assign(selected);
        changed();
      }
    } catch (e) {
      notice = `File browser unavailable: ${String(e).replace(/^Error:\s*/, "")}`;
    }
  }
  function openTab(item: Tab) {
    tab = item;
    if (item === "advanced") advancedOpened = true;
    if (item === "prompts" && !promptForm.value) void loadPrompt(promptKey);
  }
  function enhanceAdminFields(node: HTMLElement) {
    const enhance = () => {
      for (const label of node.querySelectorAll("label")) {
        const input = label.querySelector(":scope > input") as HTMLInputElement | null;
        if (!input || input.dataset.browserEnhanced) continue;
        const title = (label.childNodes[0]?.textContent ?? "").trim();
        const pathField = /path|directory|executable/i.test(title);
        const directoryOnly = /directory/i.test(title);
        const modelPath = /model path/i.test(title);
        const fileOnly = /executable|voice reference|certificate|key path/i.test(title);
        if (pathField) {
          input.dataset.browserEnhanced = "true";
          const buttons = document.createElement("span");
          buttons.className = "flex gap-2";
          const add = (text: string, directory: boolean) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "secondary";
            button.textContent = text;
            button.onclick = () =>
              void pickPath((path) => {
                input.value = path;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
              }, directory);
            buttons.append(button);
          };
          if (!directoryOnly) add("File…", false);
          if (!fileOnly || modelPath) add("Folder…", true);
          label.append(buttons);
        }
        if (title === "Family" || title === "ASR family") {
          input.setAttribute("list", title === "Family" ? "audio-tts-families" : "audio-asr-families");
          const help = document.createElement("a");
          help.href = "https://github.com/0xShug0/audio.cpp#supported-models";
          help.target = "_blank";
          help.rel = "noreferrer";
          help.className = "family-help";
          help.title = "Check your model's family in the official audio.cpp README";
          help.textContent = "?";
          label.append(help);
          input.dataset.browserEnhanced = "true";
        }
      }
      for (const details of node.querySelectorAll("details")) {
        if ((details as HTMLElement).dataset.expansionEnhanced || !details.querySelector('input[class~="field"]'))
          continue;
        const name = [...details.querySelectorAll("label")]
          .find((label) => (label.childNodes[0]?.textContent ?? "").trim() === "Name")
          ?.querySelector("input") as HTMLInputElement | null;
        if (!name) continue;
        (details as HTMLElement).dataset.expansionEnhanced = "true";
        const key = `iris.admin.service.expanded.${name.value}`;
        const saved = localStorage.getItem(key);
        details.open = saved === null ? true : saved === "true";
        details.addEventListener("toggle", () => localStorage.setItem(key, String(details.open)));
      }
      for (const console of node.querySelectorAll('pre[aria-live="polite"]')) {
        const element = console as HTMLElement;
        if (element.dataset.autoscrollEnhanced) continue;
        element.dataset.autoscrollEnhanced = "true";
        let stick = true;
        element.addEventListener("scroll", () => {
          stick = element.scrollHeight - element.scrollTop - element.clientHeight <= 8;
        });
        const outputObserver = new MutationObserver(() => {
          if (stick) requestAnimationFrame(() => (element.scrollTop = element.scrollHeight));
        });
        outputObserver.observe(element, { childList: true, characterData: true, subtree: true });
      }
    };
    enhance();
    const observer = new MutationObserver(enhance);
    observer.observe(node, { childList: true, subtree: true });
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }
  function normalizeService(service: any) {
    service.process ??= { executable: "", arguments: [], workingDirectory: "", environment: {} };
    if (service.kind === "audio") {
      service.audioCpp = {
        modelId: "pocket-tts",
        family: "pocket_tts",
        modelPath: "models/pocket-tts",
        task: "tts",
        mode: "offline",
        backend: "best",
        device: 0,
        threads: 4,
        lazyLoad: true,
        ...(service.audioCpp ?? {}),
      };
      service.audioCpp.defaultVoicePreset = {
        voiceRef: "",
        referenceText: "",
        speaker: "",
        ...(service.audioCpp.defaultVoicePreset ?? {}),
      };
      service.audioCpp.asrModel = {
        modelId: "qwen3-asr",
        family: "qwen3_asr",
        modelPath: "models/Qwen3-ASR-0.6B",
        mode: "offline",
        ...(service.audioCpp.asrModel ?? {}),
      };
    }
  }
  async function load() {
    loading = true;
    error = "";
    try {
      status = await getAdminStatus(askReauth);
      const cloned = plain(status.config);
      if (cloned === undefined) throw new Error(cloneFailureMessage);
      draft = cloned;
      for (const service of draft.services) normalizeService(service);
      advanced = JSON.stringify(draft, null, 2);
      dirty = false;
      await loadOperations();
    } catch (e) {
      try {
        bootstrap = await request("/bootstrap/status");
        error = bootstrap?.configured ? String(e) : "registration_required";
      } catch {
        error = String(e);
      }
    } finally {
      loading = false;
    }
  }
  async function refresh() {
    refreshing = true;
    const started = Date.now();
    await load();
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 350 - (Date.now() - started))));
    refreshing = false;
  }
  async function loadOperations() {
    const paths = ["/services", "/services/defaults", "/discovery", "/software", "/models", "/keys", "/prompts"];
    const results = await Promise.allSettled([...paths.map((path) => request(path)), listAdminUsers()]);
    const value = <T,>(i: number, fallback: T): T =>
      results[i].status === "fulfilled" ? ((results[i] as PromiseFulfilledResult<unknown>).value as T) : fallback;
    services = value(0, { services: [], owned: [] });
    servicePresets = parseServicePresets(results[1].status === "fulfilled" ? results[1].value : undefined);
    defaultSelections = Object.fromEntries((draft?.services ?? []).map((_: any, index: number) => [index, true]));
    discovery = parseDiscovery(value(2, { accelerators: [], os: {}, executables: [], modelFiles: [] }));
    software = value(3, {});
    const userResult = results[7];
    users = userResult.status === "fulfilled" ? userResult.value : [];
    models = parseAdminModels(value(4, { models: [] }));
    keys = value(5, { keys: [] }).keys;
    promptKeys = value(6, { prompts: [] }).prompts;
  }
  function changed() {
    const cloned = plain(draft);
    if (cloned === undefined) {
      notice = cloneFailureMessage;
      return;
    }
    draft = cloned;
    advanced = JSON.stringify(draft, null, 2);
    patch = null;
    dirty = true;
    workflowNotice = "Draft changed. Apply to validate and save it.";
  }

  /* ---- Apply stages, validates, starts/connects, tests, and saves. ---- */
  async function applyDraft() {
    confirmation = null;
    workflowNotice = "";
    notice = "";
    error = "";
    serviceFeedback = {};
    workflowBusy = true;
    applyController = new AbortController();
    const signal = applyController.signal;
    try {
      const snapshot = plain(draft);
      if (snapshot === undefined) throw new Error(cloneFailureMessage);
      for (const service of snapshot.services)
        if (service.mode === "connect-only" && !service.process?.executable) delete service.process;
      patch = parseAdminPatch(await request("/patches", { method: "POST", body: JSON.stringify(snapshot), signal }));
      patch = parseAdminPatch(await request(`/patches/${patch.id}/validate`, { method: "POST", signal }));
      serviceFeedback = Object.fromEntries(
        snapshot.services.map((service: any) => [
          service.name,
          {
            error: false,
            message:
              service.mode === "connect-only"
                ? "Checking connection…"
                : service.mode === "connect-or-start"
                  ? "Checking connection. If it is not running, starting it…"
                  : "Starting service and waiting for readiness…",
          },
        ]),
      );
      workflowNotice = "Testing services. Services that are not running will be started…";
      patch = parseAdminPatch(await request(`/patches/${patch.id}/test`, { method: "POST", signal }));
      serviceFeedback = Object.fromEntries(
        snapshot.services.map((service: any) => [service.name, { error: false, message: "Connection test passed." }]),
      );
      patch = parseAdminPatch(await request(`/patches/${patch.id}/apply`, { method: "POST", signal }));
      workflowNotice = "Applied successfully.";
      await load();
      workflowNotice = "Applied successfully.";
    } catch (e) {
      workflowNotice = signal.aborted ? "Apply aborted." : `Apply failed: ${String(e).replace(/^Error:\s*/, "")}`;
    } finally {
      workflowBusy = false;
      applyController = null;
    }
  }
  async function approve(kind: string) {
    workflowNotice = "";
    workflowBusy = true;
    try {
      if (!patch) throw new Error("No admin patch is available");
      const patchId = patch.id;
      await request(`/patches/${patchId}/approve`, { method: "POST", body: JSON.stringify({ kind }) });
      const required = (patch.redactedDiff?._approvals?.required ?? []).filter(
        (x: string) => x !== "standard" && x !== kind,
      );
      if (!required.length) {
        patch = parseAdminPatch(await request(`/patches/${patchId}/apply`, { method: "POST" }));
        await load();
        workflowNotice = "Applied successfully.";
      } else workflowNotice = `Approved ${kind}; ${required.length} approval(s) remain.`;
    } catch (e) {
      workflowNotice = String(e);
    } finally {
      workflowBusy = false;
    }
  }
  const approvalLabels: Record<string, { label: string; tip: string }> = {
    network: {
      label: "Allow network changes",
      tip: "Approves changes to server binding, public URL, trusted origins, or TLS settings.",
    },
    download: { label: "Allow downloads", tip: "Approves staged operations that download software or managed assets." },
  };
  async function resetDefaults() {
    confirmation = null;
    workflowNotice = "";
    notice = "";
    error = "";
    serviceFeedback = {};
    workflowBusy = true;
    try {
      await request("/reset-defaults", { method: "POST", body: "{}" });
      await load();
      workflowNotice = "Reset to defaults.";
    } catch (e) {
      workflowNotice = `Reset failed: ${String(e)}`;
    } finally {
      workflowBusy = false;
    }
  }

  /* ---- Default model (setup priority) ---- */
  function currentDefaultModel(): string {
    return draft.profiles.find((p: any) => p.name === "default")?.model ?? status?.defaultModel?.model ?? "";
  }
  function setDefaultModel(model: string) {
    let profile = draft.profiles.find((p: any) => p.name === "default");
    if (!profile) {
      profile = {
        name: "default",
        service: draft.services.find((s: any) => s.kind === "llm")?.name ?? "",
        acceleration: "cpu",
        inputAudio: false,
      };
      draft.profiles = [...(draft.profiles ?? []), profile];
    }
    profile.model = model;
    changed();
  }
  const needsDefaultModel = () => !currentDefaultModel();

  /* ---- Services ---- */
  function addService() {
    draft.services = [
      ...draft.services,
      {
        name: `service-${draft.services.length + 1}`,
        kind: "llm",
        mode: "start-and-manage",
        endpoint: {
          baseUrl: "http://127.0.0.1:8080/v1",
          healthCheck: { protocol: "openai-model-list" },
          startupTimeoutSeconds: 120,
        },
        process: { executable: "", arguments: [], workingDirectory: "", environment: {} },
        shutdownPolicy: "leave-running",
      },
    ];
    changed();
  }
  function removeService(i: number) {
    draft.services = draft.services.filter((_: any, index: number) => index !== i);
    changed();
  }
  function ownedNames(): Set<string> {
    return new Set((services?.owned ?? []).map((o: any) => o.service));
  }
  function probeFor(name: string): any | null {
    return (services?.services ?? []).find((s: any) => s.name === name) ?? null;
  }
  function serviceState(name: string): "running" | "starting" | "stopped" {
    const owned = ownedNames().has(name);
    const probe = probeFor(name);
    if (probe?.reachable) return "running";
    if (owned) return "starting";
    return "stopped";
  }
  async function serviceAction(name: string, action: string) {
    if (dirty) {
      serviceFeedback = {
        ...serviceFeedback,
        [name]: {
          error: true,
          message: "This service exists only in the current draft. Validate and apply the draft before starting it.",
        },
      };
      return;
    }
    serviceFeedback = {
      ...serviceFeedback,
      [name]: { error: false, message: `${action === "start" ? "Connecting/starting" : "Stopping"}…` },
    };
    try {
      const result = await request(`/services/${encodeURIComponent(name)}/${action}`, { method: "POST" });
      const readiness = result.readiness;
      serviceFeedback = {
        ...serviceFeedback,
        [name]: {
          error: Boolean(readiness && !readiness.reachable),
          message:
            readiness?.detail ??
            (result.stopped
              ? "Service stopped."
              : result.reused
                ? "Connected to the running service."
                : "Service started."),
        },
      };
      services = await request("/services");
    } catch (e) {
      serviceFeedback = { ...serviceFeedback, [name]: { error: true, message: String(e) } };
    }
  }
  function runtimeProfiles(serviceName: string) {
    return (draft.profiles ?? []).filter((p: any) => p.service === serviceName && p.name !== "default");
  }
  function addRuntimeProfile(serviceName: string) {
    draft.profiles = [
      ...(draft.profiles ?? []),
      { name: `${serviceName}-runtime`, service: serviceName, acceleration: "cpu", inputAudio: false },
    ];
    changed();
  }
  function removeRuntimeProfile(name: string) {
    draft.profiles = (draft.profiles ?? []).filter((p: any) => p.name !== name);
    changed();
  }
  function processOwner(process: unknown): string {
    return isRecord(process)
      ? (draft?.services?.find((service: any) => service.process === process)?.name ?? "service")
      : "service";
  }
  function updateArguments(process: unknown, text: string) {
    try {
      if (!isProcessEditor(process)) throw new Error("invalid process");
      const value: unknown = JSON.parse(text);
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("invalid");
      process.arguments = value;
      changed();
    } catch {
      serviceFeedback = {
        ...serviceFeedback,
        [processOwner(process)]: { error: true, message: "Arguments must be a JSON array of strings." },
      };
    }
  }
  function updateEnvironment(process: unknown, text: string) {
    try {
      if (!isProcessEditor(process)) throw new Error("invalid process");
      const value: unknown = JSON.parse(text);
      if (!isStringRecord(value)) throw new Error("invalid");
      process.environment = value;
      changed();
    } catch {
      serviceFeedback = {
        ...serviceFeedback,
        [processOwner(process)]: {
          error: true,
          message: "Environment must be a JSON object whose values are strings.",
        },
      };
    }
  }
  function toggleDefaults(index: number, enabled: boolean) {
    if (!enabled) {
      defaultSelections = { ...defaultSelections, [index]: false };
      return;
    }
    const current = draft.services[index];
    if (!isServiceKind(current.kind)) return;
    const kind: ServiceKind = current.kind;
    const preset = servicePresets[kind];
    if (!preset) return;
    const cloned = plain(preset);
    if (cloned === undefined) {
      serviceFeedback = { ...serviceFeedback, [current.name]: { error: true, message: cloneFailureMessage } };
      return;
    }
    draft.services[index] = { ...cloned, name: current.name };
    defaultSelections = { ...defaultSelections, [index]: true };
    changed();
  }
  function audioCpp(service: any): any {
    return service.audioCpp;
  }
  function executableDiscovered(executable: string): boolean {
    const normalized = (executable ?? "").replace(/\\/g, "/");
    return (discovery?.executables ?? []).some((path: string) => {
      const found = path.replace(/\\/g, "/");
      return found === normalized || found.endsWith(`/${normalized}`);
    });
  }
  function needsInstall(service: any): boolean {
    const executable = service.process?.executable ?? "";
    if (service.kind === "audio")
      return (
        !executableDiscovered(executable) &&
        !software?.audioCpp?.choices?.some((x: any) => x.installed && x.binary === executable)
      );
    if (service.kind === "llm")
      return (
        !executableDiscovered(executable) && (!software?.llamaCpp?.installed || software.llamaCpp.binary !== executable)
      );
    if (service.kind === "comfyui")
      return (
        !executableDiscovered(executable === "python3" ? "comfyui" : executable) &&
        (!software?.comfyUi?.installed || software.comfyUi.executable !== executable)
      );
    return false;
  }
  async function openInstaller(service: any) {
    installService = service;
    pendingInstall = null;
    installLog = "";
    refreshingRequirements = true;
    try {
      const [softwareResult, discoveryResult] = await Promise.all([request("/software"), request("/discovery")]);
      software = softwareResult;
      discovery = parseDiscovery(discoveryResult);
    } catch (e) {
      installLog = `Requirement refresh failed: ${String(e)}\n`;
    } finally {
      refreshingRequirements = false;
    }
  }
  async function requestInstall(path: string, body: InstallRequest): Promise<InstallResult> {
    const response = await fetch(`${apiUrl("/api")}/admin${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
      const message = isRecord(failure)
        ? typeof failure.message === "string"
          ? failure.message
          : typeof failure.error === "string"
            ? failure.error
            : undefined
        : undefined;
      throw new Error(message ?? `HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Installation response had no output stream");
    const decoder = new TextDecoder();
    let pending = "";
    let result: InstallResult | undefined;
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        const event = parseInstallEvent(JSON.parse(line) as unknown);
        if (event.type === "log") installLog = (installLog + event.text).slice(-200000);
        else if (event.type === "error") throw new Error(event.message);
        else result = event.result;
      }
      if (done) break;
    }
    if (!result) throw new Error("Installation ended without a result");
    return result;
  }
  async function installAudio(backend: string, revision: string) {
    installing = true;
    installLog = "";
    try {
      const result = await requestInstall("/software/audio.cpp/install", audioInstallPayload(backend, revision));
      installService.process.executable = result.binary;
      installService.process.workingDirectory = software.audioCpp.root;
      audioCpp(installService).backend = backend;
      software = result.status;
      changed();
      workflowNotice = "audio.cpp installed. Apply the updated service configuration.";
      installLog += "\nInstallation completed successfully.\n";
    } catch (e) {
      pendingInstall = null;
      workflowNotice = `Install failed: ${String(e)}`;
      installLog += `\nERROR: ${String(e).replace(/^Error:\s*/, "")}\n`;
    } finally {
      installing = false;
    }
  }
  async function installManaged(backend = "cpu") {
    if ((installService?.kind === "audio" || installService?.kind === "comfyui") && !pendingInstall) {
      let revision: unknown;
      try {
        const resolved = await request(
          installService.kind === "audio" ? "/software/audio.cpp/revision" : "/software/comfyui/revision",
        );
        revision = resolved?.revision;
      } catch {
        pendingInstall = null;
        workflowNotice = `Unable to determine the ${installService.kind === "audio" ? "audio.cpp" : "ComfyUI"} commit to install. Check connectivity and try again.`;
        return;
      }
      if (!isImmutableCommit(revision)) {
        pendingInstall = null;
        workflowNotice = `Unable to determine the ${installService.kind === "audio" ? "audio.cpp" : "ComfyUI"} commit to install. Refresh software status and try again.`;
        return;
      }
      pendingInstall = { ...(installService.kind === "audio" ? { backend } : {}), revision };
      return;
    }
    if (installService?.kind === "audio" || installService?.kind === "comfyui") {
      const revision = pendingInstall?.revision;
      pendingInstall = null;
      if (!revision) return;
      if (installService.kind === "audio") return installAudio(backend, revision);
      installing = true;
      installLog = "";
      try {
        const result = await requestInstall("/software/comfyui/install", comfyInstallPayload(revision));
        installService.process.executable = result.binary ?? result.executable;
        installService.process.workingDirectory = result.workingDirectory ?? software.comfyUi.root;
        software = result.status;
        changed();
        workflowNotice = "ComfyUI installed. Apply the updated service configuration.";
        installLog += "\nInstallation completed successfully.\n";
      } catch (e) {
        pendingInstall = null;
        workflowNotice = `Install failed: ${String(e)}`;
        installLog += `\nERROR: ${String(e).replace(/^Error:\s*/, "")}\n`;
      } finally {
        installing = false;
      }
    }
    installing = true;
    installLog = "";
    try {
      const kind = installService.kind;
      const result = await requestInstall(
        kind === "llm" ? "/software/llama.cpp/install" : "/software/comfyui/install",
        kind === "llm" ? { backend } : {},
      );
      installService.process.executable = result.binary ?? result.executable;
      if (kind === "llm") {
        const argumentsWithoutServe = (installService.process.arguments ?? []).filter(
          (argument: string) => argument !== "serve",
        );
        installService.process.arguments = [...(result.argumentsPrefix ?? []), ...argumentsWithoutServe];
      }
      installService.process.workingDirectory =
        result.workingDirectory ?? (kind === "llm" ? software.llamaCpp.root : software.comfyUi.root);
      software = result.status;
      changed();
      workflowNotice = `${kind === "llm" ? "llama.cpp" : "ComfyUI"} installed. Apply the updated service configuration.`;
      installLog += "\nInstallation completed successfully.\n";
    } catch (e) {
      workflowNotice = `Install failed: ${String(e)}`;
      installLog += `\nERROR: ${String(e).replace(/^Error:\s*/, "")}\n`;
    } finally {
      installing = false;
    }
  }

  /* ---- Tools: checkbox lists ---- */
  function toolGroups(): string[] {
    const groups = new Set(Object.keys(draft.tools ?? {}));
    for (const p of promptKeys)
      if (p.group === "tool") {
        const rest = p.key.slice(5);
        groups.add(rest.split(":")[0]);
      }
    return [...groups].filter((group) => !["memory", "admin_setup", "admin-setup"].includes(group)).sort();
  }
  function groupFunctions(group: string): string[] {
    return promptKeys
      .filter((p) => p.group === "tool" && p.key.startsWith(`tool:${group}:`))
      .map((p) => p.key.slice(5 + group.length + 1));
  }
  function groupChecked(group: string, field: "active" | "allowed"): boolean {
    return (draft.tools?.[group]?.[field]?.length ?? 0) > 0;
  }
  function setToolActive(group: string, on: boolean) {
    draft.tools ??= {};
    draft.tools[group] ??= { active: [], allowed: [] };
    const functions = groupFunctions(group);
    const enabled = on ? (functions.length ? functions : ["*"]) : [];
    draft.tools[group] = { active: enabled, allowed: enabled };
    changed();
  }
  function setFileMultimodal(on: boolean) {
    draft.tools ??= {};
    draft.tools.files ??= { active: [], allowed: [] };
    if (!on) draft.tools.files = { active: [], allowed: [] };
    else if (!draft.tools.files.allowed.length) draft.tools.files.active = ["read_file", "create_file"];
    changed();
  }
  function setFileAccess(on: boolean) {
    draft.tools ??= {};
    draft.tools.files ??= { active: [], allowed: [] };
    const functions = groupFunctions("files");
    draft.tools.files = on
      ? { active: functions.length ? functions : ["*"], allowed: functions.length ? functions : ["*"] }
      : { active: ["read_file", "create_file"], allowed: [] };
    changed();
  }

  /* ---- Prompts ---- */
  function promptLabel(key: string): string {
    return key.startsWith("tool:") ? `Tool · ${key.slice(5).replace(/:/g, " › ")}` : key;
  }
  async function loadPrompt(key: string = promptKey) {
    try {
      const encoded = encodeURIComponent(key).replace(/%3A/gi, "__colon__");
      const p = await request(`/prompts/${encoded}`);
      promptForm = { key, value: p.value ?? "", origin: p.origin };
      promptKey = key;
    } catch (e) {
      notice = String(e);
    }
  }
  async function savePrompt() {
    try {
      const encoded = encodeURIComponent(promptForm.key).replace(/%3A/gi, "__colon__");
      await request(`/prompts/${encoded}`, { method: "PUT", body: JSON.stringify({ value: promptForm.value }) });
      notice = "Prompt override saved.";
      await loadPrompt(promptForm.key);
    } catch (e) {
      notice = String(e);
    }
  }
  async function restorePrompt() {
    try {
      const encoded = encodeURIComponent(promptForm.key).replace(/%3A/gi, "__colon__");
      await request(`/prompts/${encoded}`, { method: "DELETE" });
      await loadPrompt(promptForm.key);
    } catch (e) {
      notice = String(e);
    }
  }

  /* ---- Speech cache units ---- */
  function ttlMinutes(event: Event) {
    const minutes = Number((event.currentTarget as HTMLInputElement).value);
    draft.cache.maxAgeSeconds = Math.max(0, Math.round(minutes * 60));
    changed();
  }
  function maxMegabytes(event: Event) {
    const mb = Number((event.currentTarget as HTMLInputElement).value);
    draft.cache.maxBytes = Math.max(0, Math.round(mb * 1024 * 1024));
    changed();
  }

  async function createAdmin() {
    notice = "";
    if (bootstrapForm.password !== bootstrapForm.passwordConfirmation) {
      notice = "Passwords do not match.";
      return;
    }
    try {
      const { passwordConfirmation: _, ...registration } = bootstrapForm;
      const created = await request("/bootstrap/create-admin", { method: "POST", body: JSON.stringify(registration) });
      const signedIn = await authClient.signIn.email({ email: created.email, password: bootstrapForm.password });
      if (signedIn.error)
        throw new Error(
          `Administrator was created, but automatic sign-in failed: ${signedIn.error.message ?? "sign in manually"}`,
        );
      location.href = "/admin?welcome=1";
    } catch (e) {
      notice = String(e);
    }
  }
  async function signIn() {
    signingIn = true;
    notice = "";
    try {
      const name = signInForm.name.trim().toLowerCase();
      const result = await authClient.signIn.email({ email: `${name}@iris.local`, password: signInForm.password });
      if (result.error) throw new Error(result.error.message ?? "Sign in failed");
      signInForm.password = "";
      await load();
    } catch (e) {
      notice = String(e);
    } finally {
      signingIn = false;
    }
  }
  async function startGuidedSetup() {
    try {
      const result = await request("/setup/chat", { method: "POST" });
      location.href = `/?chat=${encodeURIComponent(result.chatId)}`;
    } catch (e) {
      notice = String(e);
    }
  }
  async function createUser() {
    try {
      await runSensitive(() => createAdminUser(userForm));
      userForm = { name: "", email: "", password: "", role: "user" };
      await loadOperations();
    } catch (e) {
      notice = String(e);
    }
  }
  async function userAction(id: string, action: "role" | "password" | "sessions" | "delete", value?: string) {
    try {
      const perform = () => {
        if (action === "delete") {
          if (!confirm("Permanently delete this login and revoke its sessions? Chat history is retained.")) return;
          return deleteAdminUser(id);
        } else if (action === "sessions") {
          return revokeAdminSessions(id);
        } else if (action === "role") {
          return changeAdminRole(id, value ?? "user");
        } else {
          return resetAdminPassword(id, value ?? "");
        }
      };
      await runSensitive(async () => {
        await perform();
      });
      await loadOperations();
    } catch (e) {
      notice = String(e);
    }
  }
  async function runSensitive<T>(operation: () => Promise<T> | undefined): Promise<T | undefined> {
    const result = operation();
    if (!result) return undefined;
    return withRecentAuth(() => result, askReauth);
  }
  async function registerModel() {
    try {
      await request("/models", { method: "POST", body: JSON.stringify(modelForm) });
      await loadOperations();
    } catch (e) {
      notice = String(e);
    }
  }
  async function removeModel(id: string) {
    try {
      await request(`/models/${id}`, { method: "DELETE" });
      await loadOperations();
    } catch (e) {
      notice = String(e);
    }
  }
  async function saveKey() {
    try {
      await request(`/keys/${encodeURIComponent(keyForm.name)}`, {
        method: "PUT",
        body: JSON.stringify({ value: keyForm.value }),
      });
      keyForm = { name: "", value: "" };
      await loadOperations();
    } catch (e) {
      notice = String(e);
    }
  }
  function parseAdvancedConfig(value: unknown): Record<string, unknown> {
    if (
      !isRecord(value) ||
      !Array.isArray(value.services) ||
      !Array.isArray(value.profiles) ||
      !isRecord(value.server) ||
      !isRecord(value.tools) ||
      !isRecord(value.cache) ||
      value.services.some((service) => !isRecord(service)) ||
      value.profiles.some((profile) => !isRecord(profile))
    )
      throw new Error("configuration must include server, services, profiles, tools, and cache sections");
    return value;
  }
  function importAdvanced() {
    try {
      const parsed = parseAdvancedConfig(JSON.parse(advanced) as unknown);
      draft = parsed;
      changed();
      notice = "Advanced JSON loaded into the draft.";
    } catch (e) {
      notice = `Advanced JSON is invalid: ${e instanceof Error ? e.message : "please provide a valid configuration object"}`;
    }
  }
  onMount(() => {
    if (new URLSearchParams(location.search).get("welcome")) {
      notice = "Administrator created and signed in. Pick a default model below, then configure your services.";
      history.replaceState({}, "", "/admin");
    }
    void load();
  });
</script>

<main
  use:enhanceAdminFields
  data-advanced-opened={advancedOpened || (status?.version ?? 0) > 1}
  class="min-h-screen bg-zinc-950 p-4 text-zinc-100 md:p-8"
>
  {#if reauthOpen}
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"
      role="presentation"
      onclick={(e) => e.target === e.currentTarget && closeReauth(false)}
    >
      <div
        tabindex="-1"
        class="w-full max-w-sm rounded-lg border border-zinc-700 bg-zinc-900 p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reauth-title"
        onkeydown={(e) => e.key === "Escape" && closeReauth(false)}
      >
        <h2 id="reauth-title" class="text-lg font-semibold">Confirm your identity</h2>
        <p class="mt-1 text-sm text-zinc-400">Enter your administrator password to continue.</p>
        <form
          class="mt-4"
          onsubmit={(e) => {
            e.preventDefault();
            void submitReauth();
          }}
        >
          <label for="reauth-password" class="sr-only">Administrator password</label>
          <input
            id="reauth-password"
            bind:this={reauthInput}
            class="field w-full"
            type="password"
            autocomplete="current-password"
            bind:value={reauthPassword}
            aria-describedby={reauthError ? "reauth-error" : undefined}
          />
          {#if reauthError}<p id="reauth-error" class="mt-2 text-sm text-red-300" role="alert" aria-live="assertive">
              {reauthError}
            </p>{/if}
          <div class="mt-4 flex justify-end gap-2">
            <button type="button" class="secondary" onclick={() => closeReauth(false)}>Cancel</button><button
              class="primary"
              type="submit"
              disabled={reauthBusy}>{reauthBusy ? "Checking…" : "Continue"}</button
            >
          </div>
        </form>
      </div>
    </div>
  {/if}
  <datalist id="audio-tts-families"
    >{#each ttsFamilies as family}<option value={family}></option>{/each}</datalist
  ><datalist id="audio-asr-families"
    >{#each asrFamilies as family}<option value={family}></option>{/each}</datalist
  >
  <div class="mx-auto max-w-7xl">
    <header class="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p class="text-xs uppercase tracking-[.3em] text-indigo-400">Iris Admin</p>
        <h1 class="text-3xl font-semibold">Control plane</h1>
      </div>
      <div class="flex gap-2">
        <a href="/" class="rounded bg-zinc-800 px-3 py-2">Chat</a><button
          class="flex cursor-pointer items-center gap-2 rounded bg-zinc-800 px-3 py-2 active:scale-95 disabled:cursor-wait"
          disabled={refreshing}
          onclick={refresh}
          ><span class:animate-spin={refreshing}>↻</span>{refreshing ? "Refreshing…" : "Refresh"}</button
        >
      </div>
    </header>
    {#if loading}<p class="text-zinc-400">Loading…</p>{:else if error && bootstrap?.configured}
      <div class="fixed inset-0 grid place-items-center bg-black/70 p-4">
        <section class="w-full max-w-md rounded border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
          <h2 class="text-xl">Administrator sign in</h2>
          <p class="mt-2 text-sm text-zinc-400">Sign in to manage this Iris server.</p>
          <form
            class="mt-4 grid gap-3"
            onsubmit={(event) => {
              event.preventDefault();
              void signIn();
            }}
          >
            <label class="sr-only" for="admin-signin-name">administrator username</label><input
              id="admin-signin-name"
              class="field"
              autocomplete="username"
              placeholder="administrator username"
              bind:value={signInForm.name}
            /><label class="sr-only" for="admin-signin-password">password</label><input
              id="admin-signin-password"
              class="field"
              type="password"
              autocomplete="current-password"
              placeholder="password"
              bind:value={signInForm.password}
            /><button class="primary cursor-pointer disabled:cursor-wait" disabled={signingIn}
              >{signingIn ? "Signing in…" : "Sign in"}</button
            >
          </form>
          {#if notice}<p id="admin-signin-error" role="alert" aria-live="assertive" class="mt-3 text-sm text-red-300">
              {notice}
            </p>{/if}
          <p class="mt-3 text-xs text-zinc-600">{error}</p>
        </section>
      </div>
    {:else if error}
      <section class="mx-auto max-w-xl rounded border border-zinc-800 bg-zinc-900 p-6">
        <h2 class="text-xl">Administrator bootstrap</h2>
        <p class="mt-2 text-sm text-zinc-400">
          Copy the one-use token printed by the backend process. For remote servers, prefer HTTPS or an SSH tunnel
          because plain HTTP can be intercepted.
        </p>
        {#if bootstrap?.available}<p class="mt-3 text-amber-300">
            A bootstrap token is active. Enter it below.
          </p>{:else}<p class="mt-3 text-amber-300">
            No active token. Restart the unconfigured backend to print a new one.
          </p>{/if}
        <div class="mt-4 grid gap-3">
          <label class="sr-only" for="bootstrap-token">single-use setup token</label><input
            id="bootstrap-token"
            class="field"
            placeholder="single-use token from backend terminal"
            bind:value={bootstrapForm.token}
            aria-invalid={notice ? "true" : undefined}
            aria-describedby={notice ? "bootstrap-error" : undefined}
          /><label class="sr-only" for="bootstrap-name">administrator username</label><input
            id="bootstrap-name"
            class="field"
            autocomplete="username"
            placeholder="administrator username"
            bind:value={bootstrapForm.name}
          />
          <p class="text-xs text-zinc-500">Used only as your Iris login; no email address is required.</p>
          <label class="sr-only" for="bootstrap-password">administrator password</label><input
            id="bootstrap-password"
            class="field"
            type="password"
            autocomplete="new-password"
            placeholder="password"
            bind:value={bootstrapForm.password}
            aria-invalid={notice ? "true" : undefined}
            aria-describedby={notice ? "bootstrap-error" : undefined}
          /><label class="sr-only" for="bootstrap-confirm">confirm administrator password</label><input
            id="bootstrap-confirm"
            class="field"
            type="password"
            autocomplete="new-password"
            placeholder="repeat password"
            bind:value={bootstrapForm.passwordConfirmation}
            aria-invalid={notice ? "true" : undefined}
            aria-describedby={notice ? "bootstrap-error" : undefined}
          />
          <div class="flex gap-2">
            <button
              class="primary"
              disabled={!bootstrapForm.password || bootstrapForm.password !== bootstrapForm.passwordConfirmation}
              onclick={createAdmin}>Create administrator</button
            >
          </div>
        </div>
        {#if notice}<p id="bootstrap-error" role="alert" aria-live="assertive" class="mt-3 text-sm text-red-300">
            {notice}
          </p>{/if}
      </section>
    {:else}
      <nav class="mb-6 flex flex-wrap gap-2">
        {#each tabs as item}<button
            type="button"
            class={tab === item
              ? "rounded bg-indigo-600 px-3 py-2 capitalize"
              : "rounded bg-zinc-800 px-3 py-2 capitalize"}
            onclick={() => openTab(item)}>{item}</button
          >{/each}<button type="button" class="rounded bg-emerald-700 px-3 py-2" onclick={startGuidedSetup}
          >Guided setup chat</button
        >
      </nav>
      {#if confirmation}<div class="fixed inset-0 z-[60] grid place-items-center bg-black/70 p-4">
          <section class="w-full max-w-md rounded border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
            <h2 class="text-xl">{confirmation === "apply" ? "Apply configuration?" : "Reset to defaults?"}</h2>
            <p class="mt-2 text-sm text-zinc-400">
              {confirmation === "apply"
                ? "Iris will validate the draft, connect to or start configured services, test them, and save the configuration."
                : "Models, services, tools, prompts, and cache settings will be reset. Network and authentication settings are preserved."}
            </p>
            <div class="mt-5 flex justify-end gap-2">
              <button class="secondary" onclick={() => (confirmation = null)}>Cancel</button><button
                class={confirmation === "reset" ? "danger" : "primary"}
                onclick={() => (confirmation === "apply" ? applyDraft() : resetDefaults())}
                >{confirmation === "apply" ? "Apply" : "Reset to defaults"}</button
              >
            </div>
          </section>
        </div>{/if}
      {#if notice}<p class="mb-4 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300">{notice}</p>{/if}
      {#if tab === "overview"}
        <section class={"panel " + (needsDefaultModel() ? "border-amber-600" : "")}>
          <h2>
            Default chat model {#if needsDefaultModel()}<span class="text-amber-400">⚠</span>{/if}
          </h2>
          <p class="hint mt-1">Without a default model nobody can start a chat.</p>
          <div class="mt-3">
            <label
              >Default model<input
                class="field"
                list="registered-models"
                value={currentDefaultModel()}
                oninput={(e) => setDefaultModel(e.currentTarget.value)}
                placeholder="e.g. qwen2.5-7b-instruct"
              /></label
            >
          </div>
          <datalist id="registered-models"
            >{#each models as model}<option value={model.name}>{model.path}</option>{/each}</datalist
          >
        </section>
        <section class="grid gap-4 md:grid-cols-4">
          <div class="card"><small>Config version</small><strong>{status!.version}</strong></div>
          <div class="card"><small>Services</small><strong>{draft.services.length}</strong></div>
          <div class="card">
            <small>Verified checklist</small><strong
              >{status!.checklist.filter((x: any) => x.state === "verified").length}/{status!.checklist.length}</strong
            >
          </div>
          <div class="card">
            <small>Default model</small><strong
              class={"break-all text-base " + (needsDefaultModel() ? "text-amber-400" : "")}
              >{currentDefaultModel() || "not set ⚠"}</strong
            >
          </div>
        </section>
        <section class="panel">
          <h2>Setup checklist</h2>
          <div class="mt-3 grid gap-2 md:grid-cols-2">
            {#each status!.checklist as item}<div class="flex justify-between rounded bg-zinc-950 p-2">
                <span>{item.group}</span><span class="text-zinc-500">{item.state}</span>
              </div>{/each}
          </div>
        </section>
      {:else if tab === "server"}
        <section class="panel">
          <h2>
            Default chat model {#if needsDefaultModel()}<span class="text-amber-400" title="Choose a default model"
                >⚠</span
              >{/if}
          </h2>
          <p class="hint mt-1">Every new chat uses this model unless a participant specifies another one.</p>
          <div class="formgrid mt-3">
            <label
              >Default model<input
                class="field"
                list="registered-models-server"
                value={currentDefaultModel()}
                onchange={(e) => setDefaultModel(e.currentTarget.value.trim())}
                placeholder="pick a registered model"
              /></label
            >
          </div>
          <datalist id="registered-models-server"
            >{#each models as model}<option value={model.name}>{model.path}</option>{/each}</datalist
          >
        </section>
        <section class="panel">
          <h2>Server and remote access</h2>
          <div class="formgrid">
            <label>Bind host<input class="field" bind:value={draft.server.host} onchange={changed} /></label><label
              >Port<input class="field" type="number" bind:value={draft.server.port} onchange={changed} /></label
            ><label class="md:col-span-2"
              >Public URL<input class="field" bind:value={draft.server.publicUrl} onchange={changed} /></label
            ><label class="md:col-span-2"
              >Trusted origins (one per line)<textarea
                class="field h-28"
                value={draft.server.trustedOrigins.join("\n")}
                onchange={(e) => {
                  draft.server.trustedOrigins = e.currentTarget.value
                    .split(/\n/)
                    .map((x) => x.trim())
                    .filter(Boolean);
                  changed();
                }}></textarea></label
            >
          </div>
          <p class="hint">
            Network changes are staged and require a distinct approval. Restart may be required after apply.
          </p>
        </section>
      {:else if tab === "services"}
        <section class="panel">
          <div class="flex justify-between">
            <h2>LLM, Audio, and ComfyUI services</h2>
            <button class="primary" onclick={addService}>Add service</button>
          </div>
          <p class="hint mt-1">
            Launch settings are command-line arguments and environment variables on each service. Runtime choices such
            as NVIDIA (CUDA), ROCm, Vulkan, or CPU are set through those arguments/env vars or the acceleration selector
            below.
          </p>
          {#each draft.services as service: any, i}<details
              open
              class="mt-4 rounded border border-zinc-800 p-4"
              onchange={() => {
                defaultSelections = { ...defaultSelections, [i]: false };
                changed();
              }}
            >
              <summary class="flex cursor-pointer items-center gap-3 font-medium"
                ><span
                  class={"inline-block h-2.5 w-2.5 rounded-full " +
                    (serviceState(service.name) === "running"
                      ? "bg-emerald-400"
                      : serviceState(service.name) === "starting"
                        ? "bg-amber-400"
                        : "bg-zinc-600")}
                ></span><span>{service.name}</span><span class="text-xs uppercase text-zinc-500">{service.kind}</span
                >{#if isServiceKind(service.kind) && servicePresets[service.kind]}<label
                    class="ml-auto flex cursor-pointer flex-row items-center gap-2"
                    ><input
                      type="checkbox"
                      checked={defaultSelections[i] ?? false}
                      onchange={(e) => {
                        e.stopPropagation();
                        toggleDefaults(i, e.currentTarget.checked);
                      }}
                    />Use defaults</label
                  >{/if}</summary
              >
              <div class="formgrid">
                <label
                  >Name<input
                    class="field"
                    bind:value={service.name}
                    oninput={() => (draft.services = [...draft.services])}
                    onchange={changed}
                  /></label
                ><label
                  >Kind<select
                    class="field"
                    bind:value={service.kind}
                    onchange={() => {
                      normalizeService(service);
                      changed();
                    }}
                    ><option value="llm">LLM</option><option value="audio">Audio (TTS + STT)</option><option
                      value="comfyui">ComfyUI</option
                    ></select
                  ></label
                ><label
                  >Mode<select class="field" bind:value={service.mode}
                    ><option>connect-only</option><option>connect-or-start</option><option>start-and-manage</option
                    ></select
                  ></label
                ><label
                  >Health protocol<select class="field" bind:value={service.endpoint.healthCheck.protocol}
                    ><option>openai-model-list</option><option>audio</option><option>comfyui</option><option
                      >http</option
                    ></select
                  ></label
                ><label class="md:col-span-2"
                  >Base URL<input class="field" bind:value={service.endpoint.baseUrl} /></label
                >{#if service.mode !== "connect-only"}<label class="md:col-span-2"
                    >Executable or PATH command<input class="field" bind:value={service.process.executable} /></label
                  ><label class="md:col-span-2"
                    >Arguments (JSON array)<input
                      class="field"
                      value={JSON.stringify(service.process.arguments)}
                      onchange={(e) => updateArguments(service.process, e.currentTarget.value)}
                    /></label
                  ><label class="md:col-span-2"
                    >Working directory<input class="field" bind:value={service.process.workingDirectory} /></label
                  ><label class="md:col-span-2"
                    >Environment variables (JSON object)<textarea
                      class="field h-24 font-mono text-xs"
                      value={JSON.stringify(service.process.environment ?? {}, null, 2)}
                      onchange={(e) => updateEnvironment(service.process, e.currentTarget.value)}></textarea></label
                  >{/if}
              </div>
              {#if service.kind === "audio"}{@const audio = audioCpp(service)}
                <div class="mt-3 rounded bg-zinc-950 p-3">
                  <p class="text-xs uppercase tracking-wider text-zinc-500">audio.cpp · text to speech</p>
                  <div class="formgrid mt-2">
                    <label>Model ID<input class="field" bind:value={audio.modelId} onchange={changed} /></label><label
                      >Family<input class="field" bind:value={audio.family} onchange={changed} /></label
                    ><label class="md:col-span-2"
                      >Model path<input class="field" bind:value={audio.modelPath} onchange={changed} /></label
                    ><label
                      >Backend<select class="field" bind:value={audio.backend} onchange={changed}
                        ><option>best</option><option>cpu</option><option>cuda</option><option>vulkan</option><option
                          >metal</option
                        ><option>hip</option></select
                      ></label
                    ><label
                      >Device index<input
                        class="field"
                        type="number"
                        min="0"
                        bind:value={audio.device}
                        onchange={changed}
                      /></label
                    ><label
                      >Threads<input
                        class="field"
                        type="number"
                        min="1"
                        bind:value={audio.threads}
                        onchange={changed}
                      /></label
                    ><label class="flex flex-row items-center gap-2 pt-4"
                      ><input type="checkbox" bind:checked={audio.lazyLoad} onchange={changed} />Lazy-load models</label
                    ><label
                      >Default CustomVoice speaker (optional)<input
                        class="field"
                        bind:value={audio.defaultVoicePreset.speaker}
                        onchange={changed}
                        placeholder="Serena"
                      /></label
                    ><label
                      >Default voice reference path (optional)<input
                        class="field"
                        bind:value={audio.defaultVoicePreset.voiceRef}
                        onchange={changed}
                      /></label
                    ><label
                      >Default reference text (optional)<input
                        class="field"
                        bind:value={audio.defaultVoicePreset.referenceText}
                        onchange={changed}
                      /></label
                    >
                  </div>
                  <p class="mt-4 text-xs uppercase tracking-wider text-zinc-500">Speech to text</p>
                  <div class="formgrid mt-2">
                    <label>Model ID<input class="field" bind:value={audio.asrModel.modelId} onchange={changed} /></label
                    ><label
                      >ASR family<input class="field" bind:value={audio.asrModel.family} onchange={changed} /></label
                    ><label class="md:col-span-2"
                      >ASR model path<input
                        class="field"
                        bind:value={audio.asrModel.modelPath}
                        onchange={changed}
                      /></label
                    >
                  </div>
                </div>{/if}
              {#if runtimeProfiles(service.name).length || service.kind === "llm" || service.kind === "audio"}<div
                  class="mt-3 rounded bg-zinc-950 p-3"
                >
                  <p class="text-xs uppercase tracking-wider text-zinc-500">Runtime settings</p>
                  {#each runtimeProfiles(service.name) as profile: any}<div class="formgrid mt-2">
                      <label>Model<input class="field" bind:value={profile.model} onchange={changed} /></label><label
                        >Acceleration<select class="field" bind:value={profile.acceleration} onchange={changed}
                          ><option>cpu</option><option>cuda</option><option>rocm</option><option>vulkan</option><option
                            >metal</option
                          ><option>remote</option></select
                        ></label
                      >{#if service.kind === "llm"}<label class="flex flex-row items-center gap-2 pt-4"
                          ><input type="checkbox" bind:checked={profile.inputAudio} onchange={changed} />Allow audio
                          input via this profile</label
                        >{/if}<label
                        >Fallback profile name (optional)<input
                          class="field"
                          bind:value={profile.fallback}
                          onchange={changed}
                        /></label
                      >
                      <div class="pt-4">
                        <button class="danger" onclick={() => removeRuntimeProfile(profile.name)}
                          >Remove runtime settings</button
                        >
                      </div>
                    </div>{/each}{#if !runtimeProfiles(service.name).length}<button
                      class="secondary mt-2"
                      onclick={() => addRuntimeProfile(service.name)}>Add runtime settings (model, acceleration)</button
                    >{/if}
                </div>{/if}
              <div class="mt-3 flex flex-wrap items-center gap-2">
                {#if needsInstall(service)}<button class="primary" onclick={() => openInstaller(service)}
                    >Download &amp; install</button
                  >{/if}<button class="secondary" onclick={() => serviceAction(service.name, "start")}
                  >Connect/start</button
                >{#if serviceState(service.name) === "running" && ownedNames().has(service.name)}<button
                    class="secondary"
                    onclick={() => serviceAction(service.name, "stop")}>Stop</button
                  >{/if}<button class="danger" onclick={() => removeService(i)}>Remove definition</button
                >{#if probeFor(service.name) && !probeFor(service.name).reachable}<span class="text-xs text-zinc-500"
                    >{probeFor(service.name).detail}</span
                  >{/if}
              </div>
              {#if serviceFeedback[service.name]}<p
                  class={serviceFeedback[service.name].error
                    ? "mt-2 text-sm text-red-300"
                    : "mt-2 text-sm text-emerald-300"}
                >
                  {serviceFeedback[service.name].message}
                </p>{/if}
            </details>{/each}
        </section>
      {:else if tab === "tools"}
        <section class="panel">
          <h2>Tools</h2>
          <p class="hint mt-1">
            Active tools are available to AI participants. Iris keeps internal capabilities such as memory and
            administrator setup available automatically.
          </p>
          {#each toolGroups() as group}<div class="mt-3 rounded bg-zinc-950 p-3">
              <div class="flex flex-wrap items-center gap-6">
                <strong>{group}</strong>{#if group === "files"}<label
                    class="flex flex-row items-center gap-2 text-sm text-zinc-300"
                    ><input
                      type="checkbox"
                      checked={groupChecked("files", "active")}
                      onchange={(e) => setFileMultimodal(e.currentTarget.checked)}
                    />Multimodal input</label
                  ><label class="flex flex-row items-center gap-2 text-sm text-zinc-300"
                    ><input
                      type="checkbox"
                      checked={groupChecked("files", "allowed")}
                      onchange={(e) => setFileAccess(e.currentTarget.checked)}
                    />AI can access files in a sandboxed folder</label
                  >{:else}<label class="flex flex-row items-center gap-2 text-sm text-zinc-300"
                    ><input
                      type="checkbox"
                      checked={groupChecked(group, "active") && groupChecked(group, "allowed")}
                      onchange={(e) => setToolActive(group, e.currentTarget.checked)}
                    />Active</label
                  >{/if}
              </div>
              {#if groupFunctions(group).length}<p class="mt-2 text-xs text-zinc-500">
                  Functions: {groupFunctions(group).join(", ")}
                </p>{/if}
            </div>{/each}{#if !toolGroups().length}<p class="hint mt-2">No configurable tool groups discovered.</p>{/if}
        </section>
      {:else if tab === "prompts"}
        <section class="panel">
          <h2>Prompt editor</h2>
          <p class="hint mt-1">
            Pick a prompt from the dropdown. Core prompts shape Iris behavior; tool entries are the generic group
            description (“tool.md”) and per-function docs. Saving stores an override; Restore returns to the shipped
            default.
          </p>
          <div class="mt-3 flex flex-wrap gap-2">
            <select class="field max-w-md" value={promptKey} onchange={(e) => void loadPrompt(e.currentTarget.value)}
              ><optgroup label="Core prompts"
                >{#each promptKeys.filter((p) => p.group === "core") as p}<option value={p.key}
                    >{promptLabel(p.key)}</option
                  >{/each}</optgroup
              ><optgroup label="Tool prompts"
                >{#each promptKeys.filter((p) => p.group === "tool") as p}<option value={p.key}
                    >{promptLabel(p.key)}</option
                  >{/each}</optgroup
              ></select
            ><span class="self-center text-xs text-zinc-500">{promptForm.origin}</span>
          </div>
          <textarea class="field mt-3 h-80 font-mono text-xs" bind:value={promptForm.value}></textarea>
          <div class="mt-3 flex gap-2">
            <button class="primary" onclick={savePrompt}>Save override</button><button
              class="secondary"
              onclick={restorePrompt}>Restore default</button
            >
          </div>
        </section>
      {:else if tab === "speech"}
        <section class="panel">
          <div class="flex items-center justify-between gap-4">
            <div class="flex items-center gap-2">
              <h2>TTS replay cache</h2>
              <span
                class="grid h-5 w-5 cursor-help place-items-center rounded-full border border-zinc-600 text-xs"
                title="Whether the TTS files should be saved to allow replaying them">?</span
              >
            </div>
            <label class="toggle"
              ><input type="checkbox" bind:checked={draft.cache.enabled} onchange={changed} /><span></span></label
            >
          </div>
          {#if draft.cache.enabled}<div class="formgrid">
              <label
                >TTL in minutes (0 = unlimited)<input
                  class="field"
                  type="number"
                  min="0"
                  value={Math.round((draft.cache.maxAgeSeconds ?? 0) / 60)}
                  onchange={ttlMinutes}
                /></label
              ><label
                >Maximum size in MB (0 = unlimited)<input
                  class="field"
                  type="number"
                  min="0"
                  value={Math.round((draft.cache.maxBytes ?? 0) / (1024 * 1024))}
                  onchange={maxMegabytes}
                /></label
              >
            </div>{/if}
        </section>
      {:else if tab === "users"}<section class="panel">
          <h2>Users and sessions</h2>
          <div class="formgrid mt-3">
            <input class="field" placeholder="name" bind:value={userForm.name} /><input
              class="field"
              type="email"
              placeholder="email"
              bind:value={userForm.email}
            /><input class="field" type="password" placeholder="password" bind:value={userForm.password} /><select
              class="field"
              bind:value={userForm.role}><option>user</option><option>admin</option></select
            ><button class="primary" onclick={createUser}>Create user</button>
          </div>
          {#each users as user}<div class="mt-3 flex flex-wrap items-center gap-2 rounded bg-zinc-950 p-3">
              <strong>{user.name}</strong><span class="text-sm text-zinc-500">{user.email} · {user.role ?? "user"}</span
              ><button
                class="secondary ml-auto"
                onclick={() => userAction(user.id, "role", user.role === "admin" ? "user" : "admin")}
                >Toggle admin</button
              ><button
                class="secondary"
                onclick={() => {
                  const p = prompt("New password");
                  if (p) void userAction(user.id, "password", p);
                }}>Reset password</button
              ><button class="secondary" onclick={() => userAction(user.id, "sessions")}>Revoke sessions</button><button
                class="danger"
                onclick={() => userAction(user.id, "delete")}>Delete</button
              >
            </div>{/each}
          <h3 class="mt-6">Named API keys</h3>
          <p class="hint">Values are write-only and never returned.</p>
          <div class="flex gap-2">
            <input class="field" placeholder="key name" bind:value={keyForm.name} /><input
              class="field"
              type="password"
              placeholder="secret value"
              bind:value={keyForm.value}
            /><button class="primary" onclick={saveKey}>Save</button>
          </div>
          <div class="mt-2 flex flex-wrap gap-2">
            {#each keys as key}<button
                class="secondary"
                onclick={() => request(`/keys/${encodeURIComponent(key)}`, { method: "DELETE" }).then(loadOperations)}
                >{key} ×</button
              >{/each}
          </div>
        </section>
      {:else if tab === "models"}
        <!--
        Model registry (manual registration) is intentionally DISABLED for now.

        Why: it only records name/path/ownership in the admin DB; nothing in the
        runtime consumes those rows yet — chats discover models through each LLM
        service's own endpoint (/v1/models). Reintroduce this UI when the roadmap
        item "Managed runtime/model downloads" lands: `ownership: managed` then
        becomes authoritative for Iris-downloaded/pinned models, and `external`
        for declared references to shared on-disk models. The markup below and
        the registerModel/removeModel/modelForm functions in <script> are kept
        as dead code so it can be restored as-is.

      <section class="panel"><h2>Model registry</h2><p class="hint mt-1">Register the model files your services serve so they can be picked as the default chat model or assigned to a service's runtime settings. Registration just records a name and path — Iris does not move or manage the files.</p><div class="formgrid mt-3"><input class="field" placeholder="display name" bind:value={modelForm.name}><input class="field" placeholder="absolute model path (.gguf/.safetensors/.onnx)" bind:value={modelForm.path}><select class="field" bind:value={modelForm.ownership}><option>external</option><option>managed</option></select><button class="primary" onclick={registerModel}>Register</button></div>{#each models as model}<div class="mt-2 flex items-center gap-2 rounded bg-zinc-950 p-3"><strong>{model.name}</strong><span class="truncate text-xs text-zinc-500">{model.path} · {model.ownership}</span>{#if model.ownership==="managed"}<button class="danger ml-auto" onclick={()=>removeModel(model.id)}>Remove registration</button>{/if}</div>{/each}</section>
      -->
        <section class="panel">
          <h2>This machine's capabilities</h2>
          <div class="mt-3 grid gap-2 md:grid-cols-3">
            {#each discovery?.accelerators ?? [] as accel: any}<div class="rounded bg-zinc-950 p-3">
                <div class="flex items-center gap-2">
                  <span
                    class={"inline-block h-2.5 w-2.5 rounded-full " +
                      (accel.available ? "bg-emerald-400" : "bg-zinc-600")}
                  ></span><strong class="uppercase text-sm">{accel.kind}</strong>
                </div>
                <p class="mt-1 text-xs text-zinc-500">{accel.detail}</p>
                {#if accel.devices?.length}<p class="mt-1 text-xs text-zinc-400">{accel.devices.join(", ")}</p>{/if}
              </div>{/each}
          </div>
          <p class="hint mt-2">
            Detected {discovery?.modelFiles?.length ?? 0} model files (.gguf/.safetensors/.onnx). Models available to chat
            come from each connected service's own endpoint (see Services).
          </p>
          <details class="mt-2">
            <summary>Raw discovery report</summary>
            <pre class="code">{JSON.stringify(discovery, null, 2)}</pre>
          </details>
        </section>
      {:else}<section class="panel">
          <h2>Advanced configuration snapshot</h2>
          <p class="hint">This is the complete schema-validated draft. Secrets contain state only, never values.</p>
          <textarea class="field mt-3 h-96 font-mono text-xs" bind:value={advanced}></textarea><button
            class="secondary mt-2"
            onclick={importAdvanced}>Load JSON into draft</button
          >
        </section>{/if}

      {#if installService}<div class="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <section class="w-full max-w-3xl rounded border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
            <h2 class="text-xl">
              Install {installService.kind === "llm"
                ? "llama.cpp"
                : installService.kind === "audio"
                  ? "audio.cpp"
                  : "ComfyUI"}
            </h2>
            {#if refreshingRequirements}<p class="hint mt-3">
                Rechecking hardware and build requirements…
              </p>{:else if installService.kind === "comfyui"}<p class="hint mt-2">
                Downloads ComfyUI, creates an isolated Python environment, and installs its requirements.
              </p>
              {#if pendingInstall}<div class="mt-4 rounded border border-amber-700/70 bg-amber-950/30 p-3">
                  <p class="text-sm">Ready to download ComfyUI at this immutable commit:</p>
                  <code class="mt-2 block break-all text-xs text-amber-200">{pendingInstall.revision}</code>
                  <p class="mt-2 text-xs text-zinc-400">
                    This is the commit that will be downloaded; installation will not start until you confirm.
                  </p>
                  <div class="mt-3 flex gap-2">
                    <button class="primary" disabled={installing} onclick={() => installManaged()}
                      >Confirm and install</button
                    >
                    <button class="secondary" disabled={installing} onclick={() => (pendingInstall = null)}
                      >Choose another revision</button
                    >
                  </div>
                </div>{:else}<button class="primary mt-4" disabled={installing} onclick={() => installManaged()}
                  >Resolve commit to install</button
                >{/if}
              >{:else}<p class="hint mt-2">
                Choose the acceleration backend. Unavailable choices are disabled based on this machine’s current
                hardware and toolchains.
              </p>
              {#if installService.kind === "audio" && pendingInstall}<div
                  class="mt-4 rounded border border-amber-700/70 bg-amber-950/30 p-3"
                >
                  <p class="text-sm">Ready to download audio.cpp at this immutable commit:</p>
                  <code class="mt-2 block break-all text-xs text-amber-200">{pendingInstall.revision}</code>
                  <p class="mt-2 text-xs text-zinc-400">
                    This is the commit that will be downloaded; installation will not start until you confirm.
                  </p>
                  <div class="mt-3 flex gap-2">
                    <button
                      class="primary"
                      disabled={installing}
                      onclick={() => installManaged(pendingInstall?.backend ?? "cpu")}>Confirm and install</button
                    >
                    <button class="secondary" disabled={installing} onclick={() => (pendingInstall = null)}
                      >Choose another backend</button
                    >
                  </div>
                </div>{/if}
              <div class="mt-4 grid gap-2">
                {#each (installService.kind === "audio" ? software?.audioCpp?.choices : software?.llamaCpp?.choices) ?? [] as choice: any}<button
                    class="secondary text-left"
                    disabled={!choice.available || installing || (installService.kind === "audio" && !!pendingInstall)}
                    title={choice.reason}
                    onclick={() => installManaged(choice.backend)}
                    ><strong class="uppercase">{choice.backend}</strong>{#if installService.kind === "audio"}<code
                        class="ml-2 text-xs text-zinc-300"
                        >{choice.revision ?? software?.audioCpp?.revision ?? "resolving…"}</code
                      >{/if}<span class="ml-2 text-xs text-zinc-400">{choice.reason}</span>{#if choice.installed}<span
                        class="ml-2 text-emerald-400">installed</span
                      >{/if}</button
                  >{/each}
              </div>{/if}{#if installLog || installing}<pre
                class="mt-4 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-zinc-700 bg-black p-3 font-mono text-xs text-zinc-200"
                aria-live="polite">{installLog}{installing ? "\nRunning…" : ""}</pre>{/if}
            <div class="mt-4 flex justify-end">
              <button
                class="secondary"
                disabled={installing || refreshingRequirements}
                onclick={() => {
                  pendingInstall = null;
                  installService = null;
                }}>{installing ? "Working…" : "Close"}</button
              >
            </div>
          </section>
        </div>{/if}
      <section class="panel sticky bottom-3 border-indigo-900/70">
        <div class="flex flex-wrap items-center gap-2">
          <button
            class="rounded bg-emerald-700 px-3 py-2 disabled:opacity-40"
            title="Validates, starts or connects to configured services, tests them, and saves this configuration"
            disabled={workflowBusy}
            onclick={() => (confirmation = "apply")}>{workflowBusy ? "Applying…" : "Apply"}</button
          >{#if workflowBusy}<button class="danger" onclick={() => applyController?.abort()}>Abort</button
            >{/if}{#each patch?.redactedDiff?._approvals?.required ?? [] as kind}{#if kind !== "standard"}{@const approval =
                approvalLabels[kind] ?? {
                  label: `Allow ${kind}`,
                  tip: `Approves the ${kind} changes in this staged configuration.`,
                }}<button
                class="rounded bg-amber-700 px-3 py-2 text-sm"
                title={approval.tip}
                disabled={workflowBusy}
                onclick={() => approve(kind)}>{approval.label}</button
              >{/if}{/each}<button
            class="danger"
            title="Restores the factory admin configuration"
            disabled={workflowBusy}
            onclick={() => (confirmation = "reset")}>Reset to defaults</button
          >
        </div>
        {#if workflowNotice}<p
            class={workflowNotice.startsWith("Error:") ||
            workflowNotice.startsWith("Validation failed") ||
            workflowNotice.startsWith("Apply failed") ||
            workflowNotice.startsWith("Reset failed")
              ? "mt-2 text-sm text-red-300"
              : "mt-2 text-sm text-zinc-300"}
          >
            {workflowNotice}
          </p>{/if}{#if patch}<p class="mt-2 text-xs text-zinc-500">Patch {patch.id} · {patch.status}</p>{/if}
      </section>
    {/if}
  </div>
</main>

<style>
  :global(.panel) {
    margin-top: 1rem;
    border: 1px solid rgb(39 39 42);
    border-radius: 0.5rem;
    background: rgb(24 24 27);
    padding: 1.25rem;
  }
  :global(.panel h2) {
    font-size: 1.15rem;
    font-weight: 600;
  }
  :global(.card) {
    display: flex;
    flex-direction: column;
    border: 1px solid rgb(39 39 42);
    border-radius: 0.5rem;
    background: rgb(24 24 27);
    padding: 1rem;
  }
  :global(.card small),
  :global(.hint) {
    color: rgb(113 113 122);
    font-size: 0.8rem;
  }
  :global(.card strong) {
    margin-top: 0.4rem;
    font-size: 1.5rem;
  }
  :global(.formgrid) {
    margin-top: 0.75rem;
    display: grid;
    gap: 0.75rem;
  }
  @media (min-width: 768px) {
    :global(.formgrid) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  :global(label) {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.8rem;
    color: rgb(161 161 170);
  }
  :global(.field) {
    width: 100%;
    border: 1px solid rgb(63 63 70);
    border-radius: 0.375rem;
    background: rgb(9 9 11);
    padding: 0.55rem 0.65rem;
    color: rgb(244 244 245);
  }
  :global(.primary) {
    border-radius: 0.375rem;
    background: rgb(79 70 229);
    padding: 0.55rem 0.8rem;
    font-size: 0.875rem;
  }
  :global(.secondary) {
    border-radius: 0.375rem;
    background: rgb(39 39 42);
    padding: 0.55rem 0.8rem;
    font-size: 0.875rem;
  }
  :global(.danger) {
    border-radius: 0.375rem;
    background: rgb(127 29 29);
    padding: 0.55rem 0.8rem;
    font-size: 0.875rem;
  }
  :global(button:disabled) {
    opacity: 0.4;
  }
  :global(.code) {
    margin-top: 0.5rem;
    max-height: 20rem;
    overflow: auto;
    border-radius: 0.375rem;
    background: rgb(9 9 11);
    padding: 0.75rem;
    font-size: 0.7rem;
    color: rgb(161 161 170);
  }
  :global(.toggle) {
    position: relative;
    display: block;
    width: 3.5rem;
    height: 2rem;
    cursor: pointer;
  }
  :global(.toggle input) {
    position: absolute;
    opacity: 0;
  }
  :global(.toggle span) {
    position: absolute;
    inset: 0;
    border-radius: 999px;
    background: rgb(63 63 70);
    transition: 0.2s;
  }
  :global(.toggle span:after) {
    content: "";
    position: absolute;
    left: 0.25rem;
    top: 0.25rem;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
    background: white;
    transition: 0.2s;
  }
  :global(.toggle input:checked + span) {
    background: rgb(79 70 229);
  }
  :global(.toggle input:checked + span:after) {
    transform: translateX(1.5rem);
  }
  :global(main[data-advanced-opened="false"] .sticky.bottom-3) {
    display: none;
  }
  :global(.family-help) {
    display: grid;
    width: 1.25rem;
    height: 1.25rem;
    place-items: center;
    border: 1px solid rgb(82 82 91);
    border-radius: 999px;
    color: rgb(161 161 170);
    text-decoration: none;
  }
</style>
