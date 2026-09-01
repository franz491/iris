<script module lang="ts">
  export function removeFolderLabel(index: number): string {
    return `Remove allowed folder ${index + 1}`;
  }

  export function setupToolApprovalDialog(dialog: HTMLElement, deny: () => void): () => void {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        deny();
      }
      if (event.key === "Tab") {
        const focusable = [
          ...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'),
        ].filter(
          (el) =>
            !el.hasAttribute("disabled") &&
            !el.hasAttribute("hidden") &&
            el.getAttribute("aria-hidden") !== "true" &&
            !el.classList.contains("hidden"),
        );
        if (!focusable.length) return;
        const index = focusable.indexOf(document.activeElement as HTMLElement);
        const next =
          index < 0
            ? event.shiftKey
              ? focusable.length - 1
              : 0
            : event.shiftKey
              ? (index || focusable.length) - 1
              : (index + 1) % focusable.length;
        event.preventDefault();
        focusable[(next + focusable.length) % focusable.length].focus();
      }
    };
    queueMicrotask(() => {
      const firstAction = dialog.querySelector<HTMLElement>("button");
      (firstAction ?? dialog).focus();
    });
    window.addEventListener("keydown", onKeydown);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      previous?.focus();
    };
  }
</script>

<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { effectiveToolConfig, executeClientTool, setChatOverride } from "../lib/tools";
  import { tick } from "svelte";

  let busy = $state(false);
  let dialog = $state<HTMLDivElement | undefined>(undefined);
  let feedback = $state<string | null>(null);
  const req = $derived(app.pendingToolRequests[0] ?? null);
  const argsText = $derived(req ? JSON.stringify(req.arguments, null, 2) : "");
  let proposal = $state<Record<string, unknown>>({});
  $effect(() => {
    if (req?.tool === "edit_settings")
      proposal = { ...(((req.arguments as Record<string, unknown>)?.settings as Record<string, unknown>) ?? {}) };
  });
  $effect(() => {
    if (!req) return;
    let cleanup: (() => void) | undefined;
    void tick().then(() => {
      if (req && dialog) cleanup = setupToolApprovalDialog(dialog, () => void respond(false, false));
    });
    return () => cleanup?.();
  });

  function folders(): string[] {
    const value = proposal.rootFolders ?? proposal.rootFolder;
    return Array.isArray(value) ? value.map(String) : value ? [String(value)] : [""];
  }
  function setFolders(values: string[]) {
    proposal = { ...proposal, rootFolders: values, rootFolder: values[0] ?? "" };
  }
  function toolGroup(): string {
    const name = String((req?.arguments as Record<string, unknown>)?.tool ?? "");
    return name.startsWith("fe_") ? name : `fe_${name}`;
  }

  async function respond(approved: boolean, execute: boolean) {
    if (!req || busy) return;
    busy = true;
    feedback = null;
    try {
      let result: unknown;
      let error: string | undefined;
      if (approved && execute) {
        // FE-executed tool: run locally (Tauri will implement these natively)
        try {
          if (req.tool === "edit_settings") {
            const config = effectiveToolConfig(req.chatId, app.myId ?? "guest");
            const group = toolGroup();
            const old = config.tools.find((candidate) => candidate.tool === group);
            const settings = { ...(old?.settings ?? {}), ...proposal };
            setChatOverride(req.chatId, app.myId ?? "guest", {
              ...config,
              tools: [
                ...config.tools.filter((candidate) => candidate.tool !== group),
                { tool: group, requiresApproval: old?.requiresApproval ?? true, settings },
              ],
            });
            await app.pushToolConfigNow(req.chatId);
            result = { applied: true, tool: group, settings };
          } else {
            const config = effectiveToolConfig(req.chatId, app.myId ?? "guest");
            let setting = config.tools.find((candidate) => {
              const group = req.tool.startsWith("docs_")
                ? "fe_docs"
                : req.tool.startsWith("audio_")
                  ? "fe_audio"
                  : req.tool === "shell_exec"
                    ? "fe_shell"
                    : "fe_files";
              return candidate.tool === group;
            });
            if (req.tool.startsWith("audio_")) {
              if (!setting) throw new Error("the audio tool is not active");
              const filesSetting = config.tools.find((candidate) => candidate.tool === "fe_files");
              if (!filesSetting) throw new Error("the audio tool requires the files tool to be active");
              setting = {
                ...setting,
                settings: {
                  ...(setting?.settings ?? {}),
                  rootFolder: filesSetting.settings?.rootFolder,
                  rootFolders: filesSetting.settings?.rootFolders,
                },
              };
            }
            result = await executeClientTool(req.tool, (req.arguments as Record<string, unknown>) ?? {}, setting);
            if (
              req.tool === "audio_read" &&
              result &&
              typeof result === "object" &&
              typeof (result as Record<string, unknown>).wav_base64 === "string"
            ) {
              const filesSetting = config.tools.find((candidate) => candidate.tool === "fe_files");
              if (!filesSetting) throw new Error("audio recording requires the files tool to be active");
              const filename = `recordings/iris-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
              await executeClientTool(
                "create_file",
                { filename, content: (result as Record<string, string>).wav_base64, encoding: "base64" },
                filesSetting,
              );
              result = { filename };
            }
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
      }
      await app.answerToolRequest(req.requestId, approved, result, error);
      if (error) feedback = `Request could not be completed: ${error}`;
    } finally {
      busy = false;
    }
  }
</script>

{#if req}
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/70">
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role, a11y_click_events_have_key_events -->
    <div
      bind:this={dialog}
      class="w-[28rem] space-y-3 rounded-lg bg-zinc-900 p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tool-approval-title"
      tabindex="-1"
      onclick={(event) => event.stopPropagation()}
    >
      <h2 id="tool-approval-title" class="text-lg font-semibold">
        {req.requiresApproval ? "approval required" : "AI requests client tool"}
      </h2>
      <p class="text-sm text-zinc-400">
        the AI wants to use <span class="font-mono text-indigo-400">{req.tool}</span>
      </p>
      {#if req.tool === "edit_settings" && (req.arguments as Record<string, unknown>)?.reason}
        <p class="rounded bg-zinc-800 p-2 text-sm text-zinc-300">
          {String((req.arguments as Record<string, unknown>).reason)}
        </p>
      {/if}
      {#if req.tool === "edit_settings"}
        <div class="space-y-2 rounded bg-zinc-800 p-3 text-xs text-zinc-300">
          <div class="font-semibold text-zinc-100">
            Proposed settings for <span class="font-mono text-indigo-300">{toolGroup()}</span>
          </div>
          {#if toolGroup() === "fe_files" || toolGroup() === "fe_docs"}
            <div class="space-y-1">
              <div>allowed folders</div>
              {#each folders() as folder, i}
                <div class="flex gap-1">
                  <input
                    class="min-w-0 flex-1 rounded bg-zinc-900 px-2 py-1"
                    value={folder}
                    onchange={(e) => setFolders(folders().map((v, n) => (n === i ? e.currentTarget.value : v)))}
                  /><button
                    class="px-2"
                    aria-label={removeFolderLabel(i)}
                    onclick={() => setFolders(folders().filter((_, n) => n !== i))}>×</button
                  >
                </div>
              {/each}
              <button class="text-indigo-300" onclick={() => setFolders([...folders(), ""])}>+ folder</button>
            </div>
          {:else if toolGroup() === "fe_shell"}
            <label class="block"
              >working folder<input
                class="mt-1 w-full rounded bg-zinc-900 px-2 py-1"
                value={String(proposal.workingFolder ?? "")}
                onchange={(e) => (proposal = { ...proposal, workingFolder: e.currentTarget.value })}
              /></label
            >
            <label class="block"
              >execution mode<select
                class="mt-1 rounded bg-zinc-900 px-2 py-1"
                value={String(proposal.mode ?? "docker_readonly")}
                onchange={(e) => (proposal = { ...proposal, mode: e.currentTarget.value })}
                ><option>host</option><option>docker_rw</option><option>docker_readonly</option></select
              ></label
            >
          {:else}
            <pre class="max-h-32 overflow-auto">{JSON.stringify(proposal, null, 2)}</pre>
          {/if}
        </div>
      {:else}
        <pre class="max-h-48 overflow-auto rounded bg-zinc-800 p-2 text-xs text-zinc-300">{argsText}</pre>
      {/if}
      <p class="text-xs text-zinc-600">
        {#if req.requiresApproval}
          this request waits until you decide{""}
          {app.pendingToolRequests.length - 1 > 0 ? ` (${app.pendingToolRequests.length - 1} more queued)` : ""}
        {:else}
          executed by this client automatically on confirm
        {/if}
      </p>
      {#if feedback}<p class="text-sm text-red-400" role="alert">{feedback}</p>{/if}
      <div class="flex justify-end gap-2">
        <button
          class="rounded bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-50"
          disabled={busy}
          onclick={() => void respond(false, false)}
        >
          deny
        </button>
        <button
          class="rounded bg-indigo-600 px-4 py-2 text-sm hover:bg-indigo-500 disabled:opacity-50"
          disabled={busy}
          onclick={() => void respond(true, true)}
        >
          {busy ? "working…" : req.tool === "edit_settings" ? "approve settings" : "approve & run"}
        </button>
      </div>
    </div>
  </div>
{/if}
