<script lang="ts">
  import { app } from "../lib/state.svelte";
  import type { ChatSummary } from "../lib/types";

  /** focus the rename input when it mounts */
  function autofocusEl(el: HTMLElement) {
    setTimeout(() => el.focus(), 0);
  }

  let renamingId = $state<string | null>(null);
  let renameValue = $state("");
  let renameCommitId = $state<string | null>(null);

  function label(chat: ChatSummary): string {
    return chat.name ?? `chat ${new Date(chat.createdAt).toLocaleDateString()}`;
  }

  function startRename(chat: ChatSummary) {
    renamingId = chat.id;
    renameValue = chat.name ?? "";
  }

  async function commitRename(chat: ChatSummary) {
    if (renamingId !== chat.id || renameCommitId === chat.id) return;
    const name = renameValue.trim();
    renamingId = null;
    if (!name || name === chat.name) return;
    renameCommitId = chat.id;
    try {
      await app.renameCurrentChatById(chat.id, name);
    } catch (e) {
      console.error("rename failed", e);
    } finally {
      if (renameCommitId === chat.id) renameCommitId = null;
    }
  }

  async function remove(chat: ChatSummary) {
    if (!confirm(`delete "${label(chat)}"? this removes all its messages`)) return;
    try {
      await app.deleteChat(chat.id);
    } catch (e) {
      console.error("delete failed", e);
    }
  }

  function fmt(ts: string): string {
    return new Date(ts).toLocaleString();
  }
</script>

<aside class="flex w-64 flex-col border-r border-zinc-800 bg-zinc-900">
  <div class="flex items-center justify-between p-3">
    <h2 class="text-sm font-semibold text-zinc-400">chats</h2>
    {#if !app.isGuest()}
      <div class="flex gap-1">
        <button
          class="rounded px-1.5 py-1 text-xs text-zinc-500 hover:text-zinc-200"
          title="settings"
          onclick={() => (app.showSettings = true)}
        >
          ⚙
        </button>
        <button
          class="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          title="create an AI without starting a chat"
          onclick={() => (app.showNewAiCard = true)}
        >
          + AI
        </button>
        <button
          class="rounded bg-indigo-600 px-2 py-1 text-xs hover:bg-indigo-500"
          onclick={() => (app.showNewChat = true)}
        >
          + new
        </button>
      </div>
    {/if}
  </div>
  <ul class="min-h-0 flex-1 overflow-y-auto">
    {#each app.chats as chat (chat.id)}
      <li class={`group flex items-center ${chat.id === app.currentChatId ? "bg-zinc-800" : "hover:bg-zinc-800/60"}`}>
        {#if renamingId === chat.id}
          <input
            class="min-w-0 flex-1 rounded bg-zinc-700 px-2 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-500"
            bind:value={renameValue}
            use:autofocusEl
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                void commitRename(chat);
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                renamingId = null;
              }
            }}
            onblur={() => void commitRename(chat)}
          />
        {:else}
          <button
            class="min-w-0 flex-1 px-4 py-2 text-left text-sm text-zinc-300"
            onclick={() => void app.openChat(chat.id)}
          >
            <span class="block truncate">{label(chat)}</span>
          </button>
          {#if !app.isGuest()}
            <span class="hidden shrink-0 gap-1 pr-2 group-hover:flex">
              <button class="text-zinc-500 hover:text-zinc-200" title="rename" onclick={() => startRename(chat)}
                >✎</button
              >
              <button class="text-zinc-500 hover:text-red-400" title="delete chat" onclick={() => void remove(chat)}
                >🗑</button
              >
            </span>
          {/if}
        {/if}
      </li>
    {:else}
      <li class="px-4 py-2 text-sm text-zinc-600">
        {app.isGuest() ? "guests share the universal chat" : "no chats yet"}
      </li>
    {/each}
  </ul>
</aside>
