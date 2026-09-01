<script lang="ts">
  import { app } from "../lib/state.svelte";

  const visible = $derived(app.canSeeLive());
  const live = $derived(app.live);
  const name = $derived(live ? app.participantName(live.participantId) : "");
  // expanded while thinking; collapses once actual reply text starts
  const expanded = $derived(!!live && !live.content);
</script>

{#if live && visible}
  <div class="max-w-3xl">
    <div class="flex items-baseline gap-2 text-xs text-amber-400/80">
      <span class="animate-pulse">●</span>
      <span>{name} is {live.content ? "replying…" : "thinking…"}</span>
      <button
        class="ml-1 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        onclick={() => app.stopReplying(live.participantId)}
        title="stop generating">■ stop</button
      >
    </div>
    <details class="mt-1 rounded bg-zinc-900/60 px-3 py-1 text-xs text-zinc-500" open={expanded}>
      <summary class="cursor-pointer select-none hover:text-zinc-400">thought</summary>
      <p class="mt-1 whitespace-pre-wrap border-l border-zinc-700 pl-3">{live.thought || "…"}</p>
    </details>
    {#if live.content}
      <div class="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-200">{live.content}</div>
    {/if}
  </div>
{/if}
