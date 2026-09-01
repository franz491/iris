<script module lang="ts">
  export function selectionAriaPressed(selected: boolean): boolean {
    return selected;
  }

  export function setupNewChatDialog(dialog: HTMLElement, close: () => void): () => void {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
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
        if (focusable.length === 0) return;
        const index = focusable.indexOf(document.activeElement as HTMLElement);
        const next =
          index < 0
            ? event.shiftKey
              ? focusable.length - 1
              : 0
            : event.shiftKey
              ? index <= 0
                ? focusable.length - 1
                : index - 1
              : (index + 1) % focusable.length;
        if (index < 0 || next !== index) {
          event.preventDefault();
          focusable[next].focus();
        }
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
  import { identicon } from "../lib/identicon";
  import type { AiCard } from "../lib/types";

  let aiName = $state("");
  let model = $state("");
  let apiRouter = $state("llamacpp");
  let maxContext = $state(8192);
  let prompt = $state("");
  let models = $state<{ id: string; contextWindow?: number }[]>([]);
  let routers = $state<string[]>(["llamacpp", "openai-compat"]);
  /** card ids picked for the new chat */
  let picked = $state<Set<string>>(new Set());
  let userInterruptions = $state(true);
  let aiInterruptions = $state(false);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let alsoSave = $state(true);
  let dialog: HTMLFormElement;
  const close = () => (app.showNewChat = false);
  onMount(() => setupNewChatDialog(dialog, close));

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

  function toggleCard(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    picked = next;
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      const participants: {
        role: "user" | "ai";
        name?: string;
        model?: string;
        apiRouter?: string;
        maxContext?: number;
        prompt?: string;
        cardId?: string;
      }[] = [];
      // reused cards first
      for (const id of picked) {
        const card = app.aiCards.find((c) => c.id === id);
        if (card)
          participants.push({
            role: "ai",
            name: card.name,
            model: card.model,
            apiRouter: card.apiRouter,
            maxContext: card.maxContext,
            prompt: card.prompt,
            cardId: card.id,
          });
      }
      // then a freshly defined one, if given
      if (aiName.trim()) {
        const p = {
          role: "ai" as const,
          name: aiName.trim(),
          model: model.trim() || "default",
          apiRouter,
          maxContext,
          prompt,
        };
        participants.push(p);
        if (alsoSave)
          await app.saveAiCard({
            name: aiName.trim(),
            model: model.trim() || "default",
            apiRouter,
            maxContext,
            prompt,
          });
      }
      if (participants.length === 0) {
        throw new Error("pick at least one AI or define a new one");
      }
      await app.createChat(participants);
      await app.updateSettings({ userInterruptions, aiInterruptions });
      app.showNewChat = false;
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
    class="max-h-[90vh] w-96 space-y-4 overflow-y-auto rounded-lg bg-zinc-900 p-6"
    role="dialog"
    aria-modal="true"
    aria-labelledby="new-chat-title"
    aria-describedby={error ? "new-chat-error" : undefined}
    aria-busy={busy}
    tabindex="-1"
    onclick={(event) => event.stopPropagation()}
    onsubmit={create}
  >
    <h2 id="new-chat-title" class="text-lg font-semibold">new chat</h2>

    {#if app.aiCards.length > 0}
      <div>
        <p class="mb-2 text-sm text-zinc-400">your AIs — click to add</p>
        <ul class="space-y-1">
          {#each app.aiCards as card (card.id)}
            <li>
              <button
                type="button"
                class={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                  picked.has(card.id) ? "bg-indigo-600/30 ring-1 ring-indigo-500" : "hover:bg-zinc-800"
                }`}
                aria-pressed={selectionAriaPressed(picked.has(card.id))}
                onclick={() => toggleCard(card.id)}
              >
                <img src={card.avatar ?? identicon(card.avatarSeed ?? card.id, 32)} alt="" class="size-8 rounded" />
                <span class="min-w-0 flex-1">
                  <span class="block truncate">{card.name}</span>
                  <span class="block truncate text-xs text-zinc-600">{card.model}</span>
                </span>
                {#if picked.has(card.id)}<span class="text-indigo-400">✓</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <details class={app.aiCards.length > 0 ? "border-t border-zinc-800 pt-3" : ""}>
      <summary class="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200">
        {app.aiCards.length > 0 ? "+ new AI" : "define an AI"}
      </summary>
      <div class="mt-3">
        <label class="block text-sm">
          <span class="text-zinc-400">name</span>
          <input class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={aiName} placeholder="assistant" />
        </label>
        <label class="mt-2 block text-sm">
          <span class="text-zinc-400">API router</span>
          <select class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={apiRouter}>
            {#each routers as router (router)}<option value={router}>{router}</option>{/each}
          </select>
        </label>
        <label class="mt-2 block text-sm">
          <span class="text-zinc-400">model</span>
          {#if models.length > 0}
            <select class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={model} onchange={selectModel}>
              <option value="" disabled>choose a model…</option>
              {#each models as m (m.id)}
                <option value={m.id}>{m.id}{m.contextWindow ? ` (${m.contextWindow.toLocaleString()} ctx)` : ""}</option
                >
              {/each}
            </select>
          {:else}
            <input
              class="mt-1 w-full rounded bg-zinc-800 px-3 py-2"
              bind:value={model}
              placeholder="model name (no model server reachable)"
            />
          {/if}
        </label>
        <label class="mt-2 block text-sm">
          <span class="text-zinc-400">context window</span>
          <input type="number" min="1" class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" bind:value={maxContext} />
        </label>
        <label class="mt-2 block text-sm">
          <span class="text-zinc-400">system prompt (optional)</span>
          <textarea class="mt-1 w-full rounded bg-zinc-800 px-3 py-2" rows="2" bind:value={prompt}></textarea>
        </label>
        <label class="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" bind:checked={alsoSave} />
          save to your AIs
        </label>
      </div>
    </details>

    <div class="space-y-1 border-t border-zinc-800 pt-3 text-sm">
      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={userInterruptions} />
        allow user interruptions
      </label>
      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={aiInterruptions} />
        allow AI interruptions
      </label>
    </div>

    {#if error}
      <p id="new-chat-error" class="text-sm text-red-400" role="alert">{error}</p>
    {/if}

    <div class="flex justify-end gap-2">
      <button type="button" class="rounded px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200" onclick={close}>
        cancel
      </button>
      <button
        class="rounded bg-indigo-600 px-4 py-2 text-sm hover:bg-indigo-500 disabled:opacity-50"
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? "creating…" : "create chat"}
      </button>
    </div>
  </form>
</div>
