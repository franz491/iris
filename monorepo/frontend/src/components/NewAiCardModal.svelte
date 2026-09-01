<script module lang="ts">
  export function setupNewAiCardDialog(dialog: HTMLElement, close: () => void): () => void {
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
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "../lib/state.svelte";
  import { api } from "../lib/api";

  let name = $state("");
  let model = $state("");
  let apiRouter = $state("llamacpp");
  let maxContext = $state(8192);
  let prompt = $state("");
  let models = $state<{ id: string; contextWindow?: number }[]>([]);
  let routers = $state<string[]>(["llamacpp", "openai-compat"]);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let dialog: HTMLFormElement;
  const close = () => (app.showNewAiCard = false);
  onMount(() => setupNewAiCardDialog(dialog, close));

  $effect(() => {
    void api
      .listModelRouters()
      .then((r) => (routers = r.routers))
      .catch(() => {});
    void api
      .getSetupInfo()
      .then(({ defaultModel }) => {
        apiRouter = defaultModel.apiRouter;
        model = defaultModel.model;
        maxContext = defaultModel.maxContext;
      })
      .catch(() => {});
  });
  $effect(() => {
    const selectedRouter = apiRouter;
    void api
      .listModels(selectedRouter)
      .then((r) => (models = r.models))
      .catch(() => (models = []));
  });

  function selectModel() {
    const context = models.find((entry) => entry.id === model)?.contextWindow;
    if (context) maxContext = context;
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) {
      error = "name is required";
      return;
    }
    busy = true;
    error = null;
    try {
      await app.saveAiCard({ name: name.trim(), model: model.trim() || "default", apiRouter, maxContext, prompt });
      app.showNewAiCard = false;
      name = model = prompt = "";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="presentation" onclick={close}>
  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role, a11y_click_events_have_key_events -->
  <form
    bind:this={dialog}
    class="w-96 space-y-4 rounded-lg bg-zinc-900 p-6"
    role="dialog"
    aria-modal="true"
    aria-labelledby="new-ai-card-title"
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
    onsubmit={create}
  >
    <h2 id="new-ai-card-title" class="text-lg font-semibold">new AI</h2>
    <label class="block text-sm">
      <span class="text-zinc-400">name</span>
      <input class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={name} required />
    </label>
    <label class="block text-sm">
      <span class="text-zinc-400">API router</span>
      <select class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={apiRouter}>
        {#each routers as router (router)}<option value={router}>{router}</option>{/each}
      </select>
    </label>
    <label class="block text-sm">
      <span class="text-zinc-400">model</span>
      {#if models.length > 0}
        <select class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={model} onchange={selectModel}>
          <option value="" disabled>choose a model…</option>
          {#each models as m (m.id)}
            <option value={m.id}>{m.id}{m.contextWindow ? ` (${m.contextWindow.toLocaleString()} ctx)` : ""}</option>
          {/each}
        </select>
      {:else}
        <input class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={model} placeholder="model name" />
      {/if}
    </label>
    <label class="block text-sm">
      <span class="text-zinc-400">context window</span>
      <input type="number" min="1" class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={maxContext} />
    </label>
    <label class="block text-sm">
      <span class="text-zinc-400">system prompt (optional)</span>
      <textarea class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" rows="3" bind:value={prompt}></textarea>
    </label>
    {#if error}
      <p id="new-ai-card-error" class="text-sm text-red-400" role="alert">{error}</p>
    {/if}
    <div class="flex justify-end gap-2">
      <button type="button" class="rounded px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200" onclick={close}>
        cancel
      </button>
      <button class="rounded bg-indigo-600 px-4 py-2 text-sm hover:bg-indigo-500 disabled:opacity-50" disabled={busy}>
        {busy ? "saving…" : "create AI"}
      </button>
    </div>
  </form>
</div>
