<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { identicon } from "../lib/identicon";
  import type { AiCard } from "../lib/types";
  import EditCardModal from "./EditCardModal.svelte";
  import ToolSettingsModal from "./ToolSettingsModal.svelte";
  import { api } from "../lib/api";

  let editingCard = $state<AiCard | null>(null);

  const ais = $derived(app.participants.filter((p) => p.role === "ai"));
  const users = $derived(app.participants.filter((p) => p.role === "user"));
  const cards = $derived(app.aiCards);

  let adding = $state(false);
  let newRole = $state<"ai" | "user">("ai");
  let newName = $state("");
  let newModel = $state("");
  let newRouter = $state("llamacpp");
  let newMaxContext = $state(8192);
  let modelOptions = $state<{ id: string; contextWindow?: number }[]>([]);
  let routerOptions = $state<string[]>(["llamacpp", "openai-compat"]);
  let newPrompt = $state("");
  let addError = $state<string | null>(null);

  $effect(() => {
    void api
      .listModelRouters()
      .then((r) => (routerOptions = r.routers))
      .catch(() => {});
    void api
      .getSetupInfo()
      .then(({ defaultModel }) => {
        newRouter = defaultModel.apiRouter;
        newModel = defaultModel.model;
        newMaxContext = defaultModel.maxContext;
      })
      .catch(() => {});
  });
  $effect(() => {
    const selectedRouter = newRouter;
    void api
      .listModels(selectedRouter)
      .then((r) => (modelOptions = r.models))
      .catch(() => (modelOptions = []));
  });

  function selectAddedModel() {
    const context = modelOptions.find((entry) => entry.id === newModel)?.contextWindow;
    if (context) newMaxContext = context;
  }

  async function submitAdd() {
    addError = null;
    if (!newName.trim()) {
      addError = "name is required";
      return;
    }
    try {
      await app.addParticipant(
        newRole === "ai"
          ? {
              role: "ai",
              name: newName.trim(),
              model: newModel.trim() || "default",
              apiRouter: newRouter,
              maxContext: newMaxContext,
              prompt: newPrompt,
            }
          : { role: "user", name: newName.trim() },
      );
      adding = false;
      newName = newModel = newPrompt = "";
    } catch (e) {
      addError = e instanceof Error ? e.message : String(e);
    }
  }

  function avatarFor(card: AiCard): string {
    return card.avatar ?? identicon(card.avatarSeed ?? card.id, 32);
  }
</script>

<aside class="flex w-72 flex-col overflow-y-auto border-l border-zinc-800 bg-zinc-900">
  <div class="p-3">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-sm font-semibold text-zinc-400">participants</h2>
      {#if app.currentChatId}
        <button class="rounded bg-zinc-800 px-2 py-0.5 text-xs hover:bg-zinc-700" onclick={() => (adding = !adding)}>
          + add
        </button>
      {/if}
    </div>

    {#if adding}
      <form
        class="mb-3 space-y-2 rounded bg-zinc-800/60 p-2"
        onsubmit={(e) => {
          e.preventDefault();
          void submitAdd();
        }}
      >
        <div class="flex gap-1 text-xs">
          <button
            type="button"
            class={`rounded px-2 py-0.5 ${newRole === "ai" ? "bg-indigo-600" : "bg-zinc-700"}`}
            onclick={() => (newRole = "ai")}>AI</button
          >
          <button
            type="button"
            class={`rounded px-2 py-0.5 ${newRole === "user" ? "bg-indigo-600" : "bg-zinc-700"}`}
            onclick={() => (newRole = "user")}>human</button
          >
        </div>
        <input
          class="w-full rounded bg-zinc-900 px-2 py-1 text-sm"
          bind:value={newName}
          placeholder={newRole === "user" ? "registered username" : "AI name"}
        />
        {#if newRole === "ai"}
          <select class="w-full rounded bg-zinc-900 px-2 py-1 text-sm" bind:value={newRouter}>
            {#each routerOptions as router (router)}<option value={router}>{router}</option>{/each}
          </select>
          {#if modelOptions.length > 0}
            <select
              class="w-full rounded bg-zinc-900 px-2 py-1 text-sm"
              bind:value={newModel}
              onchange={selectAddedModel}
            >
              <option value="" disabled>choose a model…</option>
              {#each modelOptions as entry (entry.id)}<option value={entry.id}>{entry.id}</option>{/each}
            </select>
          {:else}
            <input class="w-full rounded bg-zinc-900 px-2 py-1 text-sm" bind:value={newModel} placeholder="model" />
          {/if}
          <input
            type="number"
            min="1"
            class="w-full rounded bg-zinc-900 px-2 py-1 text-sm"
            bind:value={newMaxContext}
            aria-label="context window"
          />
          <textarea
            class="w-full rounded bg-zinc-900 px-2 py-1 text-sm"
            rows="2"
            bind:value={newPrompt}
            placeholder="system prompt (optional)"></textarea>
        {/if}
        {#if addError}<p class="text-xs text-red-400">{addError}</p>{/if}
        <div class="flex gap-2">
          <button type="submit" class="rounded bg-indigo-600 px-2 py-1 text-xs hover:bg-indigo-500">add</button>
          <button type="button" class="text-xs text-zinc-500 hover:text-zinc-300" onclick={() => (adding = false)}
            >cancel</button
          >
        </div>
      </form>
    {/if}
    <ul class="group/list space-y-1 text-sm">
      {#each users as p (p.id)}
        <li class="flex items-center gap-2">
          <span class="size-2 rounded-full bg-emerald-500"></span>
          {p.name}
          {#if p.userId}<span class="text-xs text-zinc-600">(registered)</span>{/if}
        </li>
      {/each}
      {#each ais as p (p.id)}
        {@const pct = Math.round((app.compaction[p.id] ?? 0) * 100)}
        <li class="flex items-center gap-2">
          <span class={`size-2 rounded-full ${app.replying.has(p.id) ? "animate-pulse bg-amber-400" : "bg-indigo-500"}`}
          ></span>
          <span class={pct >= 80 ? "text-amber-400" : ""}>{p.name}</span>
          <span class="ml-auto flex items-center gap-2">
            <span class="text-xs text-zinc-600" title="context usage">{pct}%</span>
            {#if !app.isGuest()}
              <button
                class={`hidden group-hover/list:block ${p.readsOthersThoughts ? "text-indigo-400" : "text-zinc-600"}`}
                title={p.readsOthersThoughts
                  ? "sees other AIs' thinking — click to hide"
                  : "does not see other AIs' thinking — click to show"}
                onclick={() => void app.setReadsOthersThoughts(p.id, !p.readsOthersThoughts)}
                >{p.readsOthersThoughts ? "◉" : "○"} thoughts</button
              >
              <button
                class="hidden text-zinc-600 hover:text-indigo-400 group-hover/list:block"
                title="compact context now"
                onclick={() => void app.compactNow(p.id)}>⧉</button
              >
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  </div>

  {#if cards.length > 0}
    <div class="border-t border-zinc-800 p-3">
      <h2 class="mb-2 text-sm font-semibold text-zinc-400">your AIs</h2>
      <ul class="space-y-2 text-sm">
        {#each cards as card (card.id)}
          <li class="flex items-center gap-2">
            <button type="button" onclick={() => (editingCard = card)} title="edit card">
              <img src={avatarFor(card)} alt="" class="size-8 rounded hover:ring-2 hover:ring-indigo-500" />
            </button>
            <div class="min-w-0">
              <p class="truncate">{card.name}</p>
              <p class="truncate text-xs text-zinc-600">{card.model}</p>
            </div>
            <button
              class="ml-auto hidden text-zinc-600 hover:text-zinc-300 group-hover:block"
              title="edit card"
              onclick={() => (editingCard = card)}
            >
              ✎
            </button>
            <button
              class="hidden text-zinc-600 hover:text-red-400 group-hover:block"
              title="delete card"
              onclick={() => void app.removeAiCard(card.id)}
            >
              🗑
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <div class="border-t border-zinc-800 p-3">
    <button
      class="w-full rounded bg-zinc-800 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
      onclick={() => (app.showToolSettings = true)}
    >
      ⚙ tool settings
    </button>
  </div>

  <div class="mt-auto border-t border-zinc-800 p-3">
    <h2 class="mb-2 text-sm font-semibold text-zinc-400">chat settings</h2>
    <div class="flex items-center gap-2 py-1 text-sm">
      <input
        id="chat-user-interruptions"
        type="checkbox"
        checked={app.settings.userInterruptions}
        onchange={(e) => void app.updateSettings({ userInterruptions: e.currentTarget.checked })}
      />
      <label for="chat-user-interruptions">user interruptions</label>
    </div>
    <div class="flex items-center gap-2 py-1 text-sm">
      <input
        id="chat-ai-interruptions"
        type="checkbox"
        checked={app.settings.aiInterruptions}
        onchange={(e) => void app.updateSettings({ aiInterruptions: e.currentTarget.checked })}
      />
      <label for="chat-ai-interruptions">AI interruptions</label>
    </div>
    <div
      class="flex items-center gap-2 py-1 text-sm"
      title="require an AI response instead of allowing &lt;no-reply&gt;"
    >
      <input
        id="chat-force-reply"
        type="checkbox"
        checked={app.settings.forceAiReply ?? false}
        onchange={(e) => void app.updateSettings({ forceAiReply: e.currentTarget.checked })}
      />
      <label for="chat-force-reply">Force AI to reply</label>
    </div>
    <button
      class="mt-2 w-full rounded border border-red-900/60 px-2 py-1.5 text-xs text-red-300 hover:bg-red-950/40"
      onclick={() => {
        if (app.currentChatId && confirm("clear ALL messages of this chat? this cannot be undone")) {
          void app.clearCurrentContext();
        }
      }}
    >
      clear all messages
    </button>
  </div>
</aside>

{#if editingCard}
  <EditCardModal card={editingCard} close={() => (editingCard = null)} />
{/if}

{#if app.showToolSettings}
  <ToolSettingsModal
    chatId={app.currentChatId}
    close={() => {
      app.showToolSettings = false;
      app.toolSettingsFocus = null;
    }}
  />
{/if}
