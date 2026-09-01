<script module lang="ts">
  import type { ToolSetting as ImportedToolSetting } from "../lib/tools";

  const MAX_IMPORTED_TOOLS = 100;
  const MAX_SETTINGS_KEYS = 32;
  const MAX_SETTING_ARRAY_ITEMS = 100;
  const MAX_STRING_LENGTH = 16_384;
  const MAX_PROMPT_OVERRIDES = 200;
  const MAX_APPROVAL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

  export function setupDialogAccessibility(dialog: HTMLElement, close: () => void): () => void {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    queueMicrotask(() => dialog.focus());
    window.addEventListener("keydown", onKeydown);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      previous?.focus();
    };
  }
  export function setupNestedDialogAccessibility(
    dialog: HTMLElement,
    opener: HTMLElement,
    close: () => void,
  ): () => void {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    dialog.focus();
    dialog.addEventListener("keydown", onKeydown);
    return () => {
      dialog.removeEventListener("keydown", onKeydown);
      opener.focus();
    };
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function isBoundedString(value: unknown): value is string {
    return typeof value === "string" && value.length <= MAX_STRING_LENGTH;
  }

  function isImportedSettings(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value) || Object.keys(value).length > MAX_SETTINGS_KEYS) return false;
    return Object.values(value).every((entry) => {
      if (isBoundedString(entry) || typeof entry === "boolean") return true;
      if (typeof entry === "number") return Number.isFinite(entry);
      return Array.isArray(entry) && entry.length <= MAX_SETTING_ARRAY_ITEMS && entry.every(isBoundedString);
    });
  }

  function isImportedToolSetting(value: unknown): value is ImportedToolSetting {
    if (!isRecord(value) || !isBoundedString(value.tool) || value.tool.trim() === "") return false;
    if ("requiresApproval" in value && typeof value.requiresApproval !== "boolean") return false;
    if (
      "approvalTimeoutMs" in value &&
      (typeof value.approvalTimeoutMs !== "number" ||
        !Number.isInteger(value.approvalTimeoutMs) ||
        value.approvalTimeoutMs < 0 ||
        value.approvalTimeoutMs > MAX_APPROVAL_TIMEOUT_MS)
    )
      return false;
    return !("settings" in value) || isImportedSettings(value.settings);
  }

  export function validateImportedToolConfig(value: unknown): {
    tools?: ImportedToolSetting[];
    promptOverrides?: Record<string, string>;
    skippedTools: number;
    skippedPromptOverrides: number;
  } {
    if (!isRecord(value) || value.kind !== "iris.toolconfig" || value.version !== 3) {
      throw new Error("not a supported iris.toolconfig file");
    }

    let tools: ImportedToolSetting[] | undefined;
    let skippedTools = 0;
    if ("tools" in value) {
      if (!Array.isArray(value.tools) || value.tools.length > MAX_IMPORTED_TOOLS) {
        throw new Error("tool config has an invalid tools list");
      }
      tools = value.tools.filter((entry): entry is ImportedToolSetting => {
        const valid = isImportedToolSetting(entry);
        if (!valid) skippedTools += 1;
        return valid;
      });
    }

    let promptOverrides: Record<string, string> | undefined;
    let skippedPromptOverrides = 0;
    if ("promptOverrides" in value) {
      if (!isRecord(value.promptOverrides) || Object.keys(value.promptOverrides).length > MAX_PROMPT_OVERRIDES) {
        throw new Error("tool config has invalid prompt overrides");
      }
      promptOverrides = {};
      for (const [key, doc] of Object.entries(value.promptOverrides)) {
        if (key.length > MAX_STRING_LENGTH || !isBoundedString(doc)) {
          skippedPromptOverrides += 1;
          continue;
        }
        promptOverrides[key] = doc;
      }
    }

    return { tools, promptOverrides, skippedTools, skippedPromptOverrides };
  }
</script>

<script lang="ts">
  // ToolSettingsModal.svelte — per-chat AI tool configuration.
  // Tools are groups (files, shell, web_search, memory, read_tool_info).
  // Each row: "loaded" toggle (docs + schemas in AI context, persists with the
  // chat) + approval settings. Expanding a row shows settings and functions;
  // FRONTEND tools' docs are editable here (machine-local, pushed per
  // connection). Backend tool docs are read-only (managed via md files / CLI).
  // Export/import covers settings + loaded tools + frontend doc overrides.
  import { app } from "../lib/state.svelte";
  import {
    fetchToolCatalog,
    getMachineDefaults,
    getPromptOverrides,
    seedChatFromDefaults,
    setChatLoadedTools,
    setChatOverride,
    setMachineDefaults,
    setPromptOverride,
    type ToolSetting,
    type ToolCatalogEntry,
  } from "../lib/tools";
  import { pushToast } from "../lib/toasts.svelte";
  import { onMount, tick } from "svelte";

  let { chatId, close }: { chatId: string | null; close: () => void } = $props();
  let dialog: HTMLDivElement;
  onMount(() => {
    void tick().then(() => setupDialogAccessibility(dialog, close));
  });

  let catalog = $state<ToolCatalogEntry[]>([]);
  let tools = $state<ToolSetting[]>([]);
  let overrides = $state<Record<string, string>>(getPromptOverrides(app.myId ?? "guest"));
  let editingOverride = $state<string | null>(null);
  let expanded = $state<string | null>(null);
  let showPromptEditor = $state(false);
  let promptFunction = $state<{ group: ToolCatalogEntry; name: string; doc: string } | null>(null);
  let promptOpener: HTMLElement | null = null;
  let nestedDialog = $state<HTMLDivElement>();
  let nestedCleanup: (() => void) | null = null;
  let toolFeedback = $state<{ kind: "status" | "alert"; text: string } | null>(null);
  const userKey = $derived(app.myId ?? "guest");
  $effect(() => {
    if (!promptFunction) {
      nestedCleanup?.();
      nestedCleanup = null;
      return;
    }
    void tick().then(() => {
      if (nestedDialog && promptOpener)
        nestedCleanup = setupNestedDialogAccessibility(nestedDialog, promptOpener, () => {
          promptFunction = null;
        });
    });
    return () => {
      nestedCleanup?.();
      nestedCleanup = null;
    };
  });

  $effect(() => {
    void chatId;
    if (!chatId) return;
    tools = seedChatFromDefaults(chatId, userKey)
      .tools.filter((s) => s.tool.startsWith("fe_"))
      .map((s) => ({ ...s, settings: { ...s.settings } }));
    void refresh();
  });
  $effect(() => {
    const focus = app.toolSettingsFocus;
    if (!focus) return;
    expanded = focus.startsWith("fe_") ? focus : `fe_${focus}`;
  });
  async function refresh() {
    catalog = await fetchToolCatalog(chatId);
  }

  function persist() {
    if (!chatId) return;
    setChatOverride(chatId, userKey, { tools });
    void app.pushToolConfigNow(chatId);
  }

  function isLoaded(g: ToolCatalogEntry): boolean {
    if (g.alwaysLoaded) return true;
    if (g.loaded !== undefined) return g.loaded; // server truth
    return tools.some((t) => t.tool === g.name);
  }

  async function toggleLoaded(g: ToolCatalogEntry) {
    if (!chatId || g.alwaysLoaded) return;
    const next = catalog.filter((c) => !c.alwaysLoaded && isLoaded(c)).map((c) => c.name);
    const target = next.includes(g.name) ? next.filter((n) => n !== g.name) : [...next, g.name];
    try {
      await setChatLoadedTools(chatId, userKey, app.clientId, target);
      await refresh();
      persist(); // keep approval overlay in sync
    } catch (e) {
      const text = e instanceof Error ? e.message : "failed to update loaded tools";
      toolFeedback = { kind: "alert", text };
      pushToast("error", text);
    }
  }

  /** off / on / ask maps to presence in the machine overlay + requiresApproval */
  function stateOf(name: string): "off" | "on" | "ask" {
    const s = tools.find((t) => t.tool === name);
    if (!s) return "off";
    return s.requiresApproval ? "ask" : "on";
  }

  function setState(name: string, next: "off" | "on" | "ask") {
    const def = catalog.find((g) => g.name === name);
    if (def?.flavor === "provider") return;
    if (name === "fe_edit_settings" && next === "on") next = "ask";
    const rest = tools.filter((t) => t.tool !== name);
    const old = tools.find((t) => t.tool === name);
    tools = next === "off" ? rest : [...rest, { ...old, tool: name, requiresApproval: next === "ask" }];
    persist();
  }

  function setToolSetting(name: string, key: string, value: unknown) {
    tools = tools.map((s) => (s.tool === name ? { ...s, settings: { ...s.settings, [key]: value } } : s));
    persist();
  }

  function setTimeoutMs(name: string, value: number) {
    tools = tools.map((s) => (s.tool === name ? { ...s, approvalTimeoutMs: value } : s));
    persist();
  }

  function saveOverride(group: string, doc: string) {
    setPromptOverride(group, doc, userKey);
    overrides = getPromptOverrides(userKey);
    editingOverride = null;
    persist(); // pushes promptOverrides to the backend
    toolFeedback = { kind: "status", text: `override saved for "${group}" (machine-local)` };
    pushToast("info", toolFeedback.text);
  }

  function exportConfig() {
    const payload = {
      kind: "iris.toolconfig",
      version: 3,
      exportedAt: new Date().toISOString(),
      tools,
      promptOverrides: overrides,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "iris-tool-config.json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function importConfig(file: File) {
    try {
      const parsed = validateImportedToolConfig(JSON.parse(await file.text()));
      const known = new Set(catalog.map((g) => g.name));
      if (parsed.tools) {
        let imported = parsed.tools.filter((t) => typeof t?.tool === "string");
        if (known.size > 0)
          imported = imported.filter(
            (t) => known.has(t.tool) && catalog.find((g) => g.name === t.tool)?.flavor === "frontend",
          );
        tools = imported;
        persist();
      }
      if (parsed.promptOverrides) {
        for (const [g, doc] of Object.entries(parsed.promptOverrides)) {
          const [group] = g.split(":", 1);
          if (!known.has(group)) continue;
          const def = catalog.find((c) => c.name === group);
          if (def?.editable) setPromptOverride(g, String(doc), userKey);
        }
        overrides = getPromptOverrides(userKey);
        persist();
      }
      await refresh();
      const skipped = parsed.skippedTools + parsed.skippedPromptOverrides;
      pushToast(
        "info",
        skipped
          ? `tool config imported; skipped ${skipped} invalid entr${skipped === 1 ? "y" : "ies"}`
          : "tool config imported",
      );
    } catch (e) {
      const text = e instanceof Error ? e.message : "import failed";
      toolFeedback = { kind: "alert", text };
      pushToast("error", text);
    }
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="presentation" onclick={close}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
  <div
    class="flex max-h-[85vh] w-[640px] flex-col rounded-lg border border-zinc-700 bg-zinc-900 p-4"
    role="dialog"
    bind:this={dialog}
    tabindex="-1"
    aria-labelledby="tool-settings-title"
    onclick={(e) => e.stopPropagation()}
  >
    {#if toolFeedback}<p
        role={toolFeedback.kind}
        aria-live={toolFeedback.kind === "alert" ? "assertive" : "polite"}
        class="sr-only"
      >
        {toolFeedback.text}
      </p>{/if}
    <div class="mb-2 flex items-center justify-between">
      <h2 id="tool-settings-title" class="text-sm font-semibold text-zinc-300">AI tool settings</h2>
      <button aria-label="Close tool settings" class="text-zinc-500 hover:text-zinc-200" onclick={close}>✕</button>
    </div>
    <p class="mb-3 text-xs text-zinc-600">
      Local setup belongs only to you, this chat, and this device. Server tools are configured by the administrator.
    </p>

    <ul class="min-h-0 flex-1 space-y-1.5 overflow-y-auto text-sm">
      {#each catalog as g (g.name)}
        {@const st = stateOf(g.name)}
        <li class="rounded bg-zinc-800/50">
          <div class="flex items-center gap-2 p-2">
            <button
              class="w-4 text-zinc-500 hover:text-zinc-200"
              title={expanded === g.name ? "collapse" : "details"}
              onclick={() => (expanded = expanded === g.name ? null : g.name)}
            >
              {expanded === g.name ? "▾" : "▸"}
            </button>
            <label class="flex items-center gap-1.5" title="load tool documentation into the context">
              <input
                type="checkbox"
                checked={isLoaded(g)}
                disabled={g.alwaysLoaded}
                onchange={() => void toggleLoaded(g)}
                aria-label="load tool documentation into the context"
              />
              <span class={`font-mono text-xs ${isLoaded(g) ? "text-zinc-100" : "text-zinc-500"}`}
                >{g.aiName ?? g.name}</span
              >
            </label>
            <span class="group relative">
              <span class="cursor-help text-[10px] text-zinc-500 hover:text-zinc-300">?</span>
              <span
                class="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden w-64 -translate-x-1/2 rounded bg-zinc-800 p-2 text-xs text-zinc-300 shadow-lg group-hover:block"
              >
                The AI will only read the documentation for a tool once it deems it might be useful based on its name.
                Setting this option will force the AI to read the tool's documentation.
              </span>
            </span>
            {#if g.alwaysLoaded}
              <span class="rounded bg-emerald-900 px-1.5 py-0.5 text-[10px] text-emerald-300">always loaded</span>
            {/if}
            <span
              class={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${g.flavor === "provider" ? "bg-sky-900 text-sky-300" : "bg-fuchsia-900 text-fuchsia-300"}`}
            >
              {g.flavor}
            </span>
            {#if g.flavor === "provider"}
              <span class="rounded bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-500">admin managed</span>
            {:else}
              <select
                class="rounded bg-zinc-900 px-1.5 py-0.5 text-xs"
                title="execution policy"
                value={st}
                onchange={(e) => setState(g.name, e.currentTarget.value as "off" | "on" | "ask")}
              >
                <option value="off">off</option>
                {#if g.name !== "fe_edit_settings"}<option value="on">on</option>{/if}
                <option value="ask">ask</option>
              </select>
            {/if}
          </div>

          {#if expanded === g.name}
            <div class="space-y-2 border-t border-zinc-700/60 px-3 py-2">
              {#if g.name === "fe_files" && st !== "off"}
                <label class="block text-xs text-zinc-500">
                  allowed folder
                  <input
                    class="mt-1 w-full rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
                    placeholder="/home/me/project"
                    value={String(
                      (tools.find((t) => t.tool === g.name)?.settings?.rootFolders as unknown[] | undefined)?.[0] ??
                        tools.find((t) => t.tool === g.name)?.settings?.rootFolder ??
                        "",
                    )}
                    onchange={(e) => {
                      setToolSetting(g.name, "rootFolder", e.currentTarget.value.trim());
                      setToolSetting(g.name, "rootFolders", [e.currentTarget.value.trim()]);
                    }}
                  />
                </label>
                <p class="text-[10px] text-zinc-600">The AI can access only relative paths underneath this folder.</p>
              {/if}
              {#if g.name === "fe_docs" && st !== "off"}
                <label class="block text-xs text-zinc-500">
                  documentation folder
                  <input
                    class="mt-1 w-full rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
                    placeholder="/home/me/docs"
                    value={String(tools.find((t) => t.tool === g.name)?.settings?.rootFolder ?? "")}
                    onchange={(e) => setToolSetting(g.name, "rootFolder", e.currentTarget.value.trim())}
                  />
                </label>
              {/if}
              {#if g.name === "fe_shell" && st !== "off"}
                <label class="block text-xs text-zinc-500">
                  working folder
                  <input
                    class="mt-1 w-full rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-300"
                    placeholder="/home/me/project"
                    value={String(tools.find((t) => t.tool === g.name)?.settings?.workingFolder ?? "")}
                    onchange={(e) => setToolSetting(g.name, "workingFolder", e.currentTarget.value.trim())}
                  />
                </label>
                <label class="flex items-center gap-2 text-xs text-zinc-500">
                  execution mode
                  <select
                    class="rounded bg-zinc-900 px-1.5 py-0.5 text-xs"
                    value={tools.find((t) => t.tool === g.name)?.settings?.mode ?? "docker_readonly"}
                    onchange={(e) => {
                      const name = g.name;
                      const mode = e.currentTarget.value;
                      setToolSetting(name, "mode", mode);
                    }}
                  >
                    <option value="host">direct on host</option>
                    <option value="docker_rw">Docker read/write</option>
                    <option value="docker_readonly">Docker readonly</option>
                  </select>
                </label>
                <p class="text-[10px] text-zinc-600">
                  Docker exposes only this folder at /sandbox. Direct host mode starts here but is not
                  filesystem-sandboxed.
                </p>
              {/if}
              {#if st === "ask"}
                <label class="flex items-center gap-2 text-xs text-zinc-500">
                  approval timeout
                  <input
                    type="number"
                    class="w-24 rounded bg-zinc-900 px-1 py-0.5"
                    min="0"
                    step="1000"
                    value={tools.find((t) => t.tool === g.name)?.approvalTimeoutMs ?? 120000}
                    onchange={(e) => setTimeoutMs(g.name, Number(e.currentTarget.value))}
                  />
                  ms (0 = wait forever)
                </label>
              {/if}

              {#if showPromptEditor && editingOverride === g.name}
                <div>
                  {#if g.editable && editingOverride === g.name}
                    <textarea
                      class="mt-1 min-h-24 w-full rounded bg-zinc-950/60 p-2 font-mono text-xs text-zinc-300 outline-none focus:ring-1 focus:ring-indigo-500"
                      bind:value={overrides[g.name]}></textarea>
                    <div class="mt-1 flex gap-2 text-xs">
                      <button
                        class="rounded bg-indigo-600 px-2 py-1 hover:bg-indigo-500"
                        onclick={() => saveOverride(g.name, overrides[g.name] ?? "")}>save override</button
                      >
                      <button
                        class="rounded px-2 py-1 text-zinc-400 hover:text-zinc-200"
                        onclick={() => (editingOverride = null)}>cancel</button
                      >
                    </div>
                  {:else}
                    <pre
                      class="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded bg-zinc-950/60 p-2 text-xs text-zinc-400">{overrides[
                        g.name
                      ] ?? g.toolDoc}</pre>
                    {#if g.editable}
                      <button
                        class="mt-1 text-xs text-indigo-400 hover:text-indigo-300"
                        onclick={() => (editingOverride = g.name)}
                      >
                        ✎ edit description (this machine)
                      </button>
                    {/if}
                  {/if}
                </div>
              {/if}

              {#if Object.keys(g.functions).length > 0}
                <div>
                  <p class="text-[10px] uppercase tracking-wide text-zinc-600">functions (loaded via read_tool_info)</p>
                  <ul class="mt-1 space-y-1">
                    {#each Object.entries(g.functions) as [fname, f] (fname)}
                      <li class="rounded bg-zinc-950/40 p-2">
                        <div class="flex items-center justify-between">
                          <p class="font-mono text-xs text-zinc-300">{fname}</p>
                          <button
                            class="text-[10px] text-indigo-400 hover:text-indigo-300"
                            onclick={(event) => {
                              promptOpener = event.currentTarget as HTMLElement;
                              promptFunction = { group: g, name: fname, doc: overrides[`${g.name}:${fname}`] ?? f.doc };
                            }}>view/edit prompt</button
                          >
                        </div>
                        <p class="mt-0.5 text-xs text-zinc-500">prompt hidden — use the button to view it</p>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {:else}
        <li class="px-2 py-4 text-center text-xs text-zinc-600">no tools registered</li>
      {/each}
    </ul>

    <div class="mt-3 flex items-center justify-between border-t border-zinc-800 pt-3">
      <div class="flex gap-2 text-xs">
        <button
          class="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          onclick={() => (showPromptEditor = !showPromptEditor)}
        >
          {showPromptEditor ? "hide prompts" : "edit prompts"}
        </button>
        <button class="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200" onclick={exportConfig}
          >export</button
        >
        <label class="cursor-pointer rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200">
          import<input
            type="file"
            accept="application/json,.json"
            class="hidden"
            onchange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void importConfig(f);
              e.currentTarget.value = "";
            }}
          />
        </label>
        {#if chatId}
          <button
            class="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            onclick={() => {
              setMachineDefaults(userKey, { tools });
              pushToast("info", "saved as machine defaults for new chats");
            }}
          >
            use as defaults
          </button>
        {/if}
      </div>
      <button class="rounded bg-indigo-600 px-3 py-1.5 text-xs hover:bg-indigo-500" onclick={close}>done</button>
    </div>
  </div>
</div>
{#if promptFunction}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
    role="presentation"
    onclick={() => (promptFunction = null)}
  >
    <div
      id="prompt-editor-dialog"
      bind:this={nestedDialog}
      class="w-[560px] rounded-lg border border-zinc-700 bg-zinc-900 p-4"
      role="dialog"
      tabindex="-1"
      aria-labelledby="prompt-editor-title"
      onclick={(e) => e.stopPropagation()}
    >
      <div class="mb-2 flex items-center justify-between">
        <h3 id="prompt-editor-title" class="font-mono text-xs text-zinc-300">
          {promptFunction.group.aiName ?? promptFunction.group.name} / {promptFunction.name}
        </h3>
        <button aria-label="Close prompt editor" class="text-zinc-500" onclick={() => (promptFunction = null)}>✕</button
        >
      </div>
      <textarea
        class="min-h-48 w-full rounded bg-zinc-950/70 p-2 font-mono text-xs text-zinc-300"
        bind:value={promptFunction.doc}></textarea>
      <div class="mt-2 flex justify-end gap-2 text-xs">
        <button class="rounded px-2 py-1 text-zinc-400" onclick={() => (promptFunction = null)}>cancel</button><button
          class="rounded bg-indigo-600 px-2 py-1"
          onclick={() => {
            saveOverride(`${promptFunction!.group.name}:${promptFunction!.name}`, promptFunction!.doc);
            promptFunction = null;
          }}>save prompt</button
        >
      </div>
    </div>
  </div>
{/if}
