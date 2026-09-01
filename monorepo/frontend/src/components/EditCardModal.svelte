<script module lang="ts">
  export function setupEditCardDialog(dialog: HTMLElement, close: () => void): () => void {
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
  import { identicon } from "../lib/identicon";
  import { api } from "../lib/api";
  import type { AiCard } from "../lib/types";

  let { card, close }: { card: AiCard; close: () => void } = $props();

  // intentional snapshot: the edit form works on a copy until saved
  // svelte-ignore state_referenced_locally -- intentional snapshot; the form edits a copy until saved
  const initial: AiCard = { ...card };
  let name = $state(initial.name);
  let model = $state(initial.model);
  let apiRouter = $state(initial.apiRouter ?? "llamacpp");
  let maxContext = $state(initial.maxContext ?? 8192);
  let models = $state<{ id: string; contextWindow?: number }[]>([]);
  let routers = $state<string[]>(["llamacpp", "openai-compat"]);
  let prompt = $state(initial.prompt);
  /** pending new avatar as data URI; null = unchanged; "" = removed */
  let avatarData = $state<string | null | undefined>(undefined);
  let preview = $derived(avatarData ?? card.avatar ?? identicon(card.avatarSeed ?? card.id, 96));
  let propagate = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let dialog: HTMLFormElement;
  onMount(() => setupEditCardDialog(dialog, close));

  $effect(() => {
    void api
      .listModelRouters()
      .then((r) => (routers = r.routers))
      .catch(() => {});
    void api
      .listModels(apiRouter)
      .then((r) => (models = r.models))
      .catch(() => (models = []));
  });

  function routerChanged() {
    model = "";
  }

  function modelChanged() {
    const context = models.find((entry) => entry.id === model)?.contextWindow;
    if (context) maxContext = context;
  }

  function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 190 * 1024) {
      // base64 inflates ~4/3; keep under the server's 256KB data-URI cap
      error = "image too large (max ~190KB)";
      input.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      avatarData = String(reader.result);
      error = null;
    };
    reader.readAsDataURL(file);
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      const patch: Record<string, unknown> = {
        name: name.trim(),
        model: model.trim() || "default",
        apiRouter,
        maxContext,
        prompt,
      };
      if (avatarData !== undefined) patch.avatar = avatarData === "" ? null : avatarData;
      if (propagate) patch.propagate = true;
      await app.updateAiCard(card.id, patch);
      close();
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
    aria-labelledby="edit-card-title"
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
    onsubmit={save}
  >
    <h2 id="edit-card-title" class="text-lg font-semibold">edit “{card.name}”</h2>

    <div class="flex items-center gap-4">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <img src={preview} alt="avatar" class="size-20 rounded" />
      <div class="text-sm">
        <label class="cursor-pointer rounded bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700">
          upload image
          <input type="file" accept="image/*" class="hidden" onchange={onFile} />
        </label>
        {#if avatarData !== undefined}
          <button
            type="button"
            class="mt-2 block text-xs text-zinc-500 hover:text-zinc-300"
            onclick={() => (avatarData = undefined)}
          >
            undo change
          </button>
        {:else if card.avatar}
          <button
            type="button"
            class="mt-2 block text-xs text-zinc-500 hover:text-red-400"
            onclick={() => (avatarData = "")}
          >
            remove image (back to identicon)
          </button>
        {/if}
      </div>
    </div>

    <label class="block text-sm">
      <span class="text-zinc-400">name</span>
      <input class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={name} required />
    </label>
    <label class="block text-sm">
      <span class="text-zinc-400">API router</span>
      <select class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={apiRouter} onchange={routerChanged}>
        {#each routers as router (router)}<option value={router}>{router}</option>{/each}
      </select>
    </label>
    <label class="block text-sm">
      <span class="text-zinc-400">model</span>
      {#if models.length > 0}
        <select class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={model} onchange={modelChanged}>
          <option value="" disabled>choose a model…</option>
          {#each models as entry (entry.id)}
            <option value={entry.id}
              >{entry.id}{entry.contextWindow ? ` (${entry.contextWindow.toLocaleString()} ctx)` : ""}</option
            >
          {/each}
        </select>
      {:else}
        <input class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={model} />
      {/if}
    </label>
    <label class="block text-sm">
      <span class="text-zinc-400">context window</span>
      <input type="number" min="1" class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={maxContext} />
    </label>
    <label class="block text-sm">
      <span class="text-zinc-400">system prompt</span>
      <textarea class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" rows="3" bind:value={prompt}></textarea>
    </label>

    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" bind:checked={propagate} />
      <span>change on all chats created from this card?</span>
    </label>

    {#if error}
      <p id="edit-card-error" class="text-sm text-red-400" role="alert">{error}</p>
    {/if}

    <div class="flex justify-end gap-2">
      <button type="button" class="rounded px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200" onclick={close}>
        cancel
      </button>
      <button class="rounded bg-indigo-600 px-4 py-2 text-sm hover:bg-indigo-500 disabled:opacity-50" disabled={busy}>
        {busy ? "saving…" : "save"}
      </button>
    </div>
  </form>
</div>
