<script lang="ts">
  import { toasts, dismissToast } from "../lib/toasts.svelte";
</script>

<div class="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 flex-col gap-2">
  {#each toasts as t (t.id)}
    <div
      class={`pointer-events-auto rounded-lg px-4 py-3 text-sm shadow-lg ${
        t.kind === "error"
          ? "bg-red-950/90 text-red-200 ring-1 ring-red-800"
          : t.kind === "warn"
            ? "bg-amber-950/90 text-amber-200 ring-1 ring-amber-800"
            : "bg-zinc-900/95 text-zinc-200 ring-1 ring-zinc-700"
      }`}
      role="status"
    >
      <div class="flex items-start gap-2">
        <p class="min-w-0 flex-1 break-words">{t.message}</p>
        <button class="text-zinc-500 hover:text-zinc-300" onclick={() => dismissToast(t.id)}>✕</button>
      </div>
    </div>
  {/each}
</div>
