<script lang="ts">
  import { app } from "../lib/state.svelte";
</script>

<div class="border-t border-zinc-800 bg-zinc-900" style="height: 40vh;">
  <div class="flex h-full flex-col">
    <div class="flex items-center justify-between border-b border-zinc-800 px-3 py-1 text-xs text-zinc-500">
      <span>bottom panel (plugin surface)</span>
      <button class="hover:text-zinc-300" onclick={() => (app.bottomOpen = false)}>✕</button>
    </div>
    <div class="flex-1 overflow-auto p-3 text-sm text-zinc-600">empty — reserved for plugin surfaces</div>
  </div>
</div>
