<script module lang="ts">
  export function setupSettingsDialog(dialog: HTMLElement, close: () => void): () => void {
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
  // SettingsModal.svelte — the central settings menu: profile, connection
  // (backend URL), diagnostics (log verbosity), and pointers into the
  // per-chat tool settings (which also hold machine defaults).
  import { backendBase, backendIsDefault, envBackendUrl, setBackendBase } from "../lib/backend";
  import { getLogLevel, setLogLevel, type LogLevel } from "../lib/log";
  import { app } from "../lib/state.svelte";
  import { onMount } from "svelte";

  let { close }: { close: () => void } = $props();

  const LEVELS: LogLevel[] = ["silent", "info", "debug"];

  let url = $state(backendBase());
  let level = $state<LogLevel>(getLogLevel());
  let error = $state<string | null>(null);
  let currentCredential = $state("");
  let newCredential = $state("");
  let confirmCredential = $state("");
  let credentialMode = $state<"password" | "pin">("password");
  let credentialError = $state<string | null>(null);
  let changingCredential = $state(false);
  let dialog: HTMLDivElement;
  onMount(() => setupSettingsDialog(dialog, close));

  const changed = $derived(normalize(url) !== backendBase());

  function normalize(u: string): string {
    const t = u.trim().replace(/\/+$/, "");
    if (!t) return "";
    return /^https?:\/\//i.test(t) ? t : `http://${t}`;
  }

  function save() {
    const next = normalize(url);
    if (next && !/^https?:\/\/[\w.-]+(:\d+)?$/i.test(next)) {
      error = "must be an origin like http://host:3000 (no path)";
      return;
    }
    setBackendBase(next);
    location.reload(); // SSE + auth client bind to the URL at startup
  }

  function applyLevel() {
    setLogLevel(level);
  }

  async function changeCredential() {
    credentialError = null;
    if (!currentCredential) {
      credentialError = "enter your current credential";
      return;
    }
    if (credentialMode === "pin" ? !/^\d{4,6}$/.test(newCredential) : newCredential.length < 4) {
      credentialError = credentialMode === "pin" ? "PIN must be 4-6 digits" : "password must be at least 4 characters";
      return;
    }
    if (newCredential !== confirmCredential) {
      credentialError = "new credentials do not match";
      return;
    }
    changingCredential = true;
    try {
      await app.changeCredential(currentCredential, newCredential);
      currentCredential = newCredential = confirmCredential = "";
      credentialError = "saved; other sessions were signed out";
    } catch (e) {
      credentialError = e instanceof Error ? e.message : "credential change failed";
    } finally {
      changingCredential = false;
    }
  }
</script>

<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="presentation" onclick={close}>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
  <div
    class="max-h-[85vh] w-96 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-4"
    role="dialog"
    bind:this={dialog}
    tabindex="-1"
    aria-labelledby="settings-title"
    onclick={(e) => e.stopPropagation()}
  >
    <h2 id="settings-title" class="mb-3 text-sm font-semibold text-zinc-300">settings</h2>

    <!-- profile -->
    <section class="mb-4">
      <h3 class="mb-1 text-xs uppercase tracking-wide text-zinc-500">profile</h3>
      {#if app.session.kind === "user"}
        <p class="text-sm text-zinc-300">{app.session.name}<span class="text-zinc-600"> (@iris.local)</span></p>
        <button
          class="mt-2 rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
          onclick={() => void app.logout()}
        >
          log out
        </button>
      {:else}
        <p class="text-sm text-zinc-400">browsing as guest — log in from the start screen to get your own chats.</p>
      {/if}
      {#if app.session.kind === "user"}
        <details class="mt-3">
          <summary class="cursor-pointer text-xs text-zinc-400">change password or PIN</summary>
          <div class="mt-2 space-y-2">
            <label class="sr-only" for="current-credential">current password or PIN</label><input
              id="current-credential"
              class="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm"
              type="password"
              autocomplete="current-password"
              placeholder="current password or PIN"
              bind:value={currentCredential}
            />
            <div class="flex gap-1">
              <button
                class={`rounded px-2 py-1 text-xs ${credentialMode === "password" ? "bg-indigo-600" : "bg-zinc-800"}`}
                onclick={() => (credentialMode = "password")}>password</button
              >
              <button
                class={`rounded px-2 py-1 text-xs ${credentialMode === "pin" ? "bg-indigo-600" : "bg-zinc-800"}`}
                onclick={() => (credentialMode = "pin")}>PIN</button
              >
            </div>
            <label class="sr-only" for="new-credential">new password or PIN</label><input
              id="new-credential"
              class="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm"
              type="password"
              autocomplete="new-password"
              placeholder={credentialMode === "pin" ? "new PIN (4-6 digits)" : "new password (4+ characters)"}
              inputmode={credentialMode === "pin" ? "numeric" : "text"}
              bind:value={newCredential}
            />
            <label class="sr-only" for="confirm-credential">confirm new password or PIN</label><input
              id="confirm-credential"
              class="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm"
              type="password"
              autocomplete="new-password"
              placeholder="confirm new credential"
              inputmode={credentialMode === "pin" ? "numeric" : "text"}
              bind:value={confirmCredential}
            />
            {#if credentialError}<p
                id="credential-feedback"
                role={credentialError.startsWith("saved") ? "status" : "alert"}
                aria-live="polite"
                class="text-xs text-zinc-400"
              >
                {credentialError}
              </p>{/if}
            <button
              class="rounded bg-indigo-600 px-2 py-1 text-xs hover:bg-indigo-500 disabled:opacity-40"
              disabled={changingCredential}
              onclick={() => void changeCredential()}>{changingCredential ? "saving…" : "save credential"}</button
            >
          </div>
        </details>
      {/if}
    </section>

    <!-- connection -->
    <section class="mb-4">
      <h3 class="mb-1 text-xs uppercase tracking-wide text-zinc-500">connection</h3>
      <label class="block text-xs text-zinc-500" for="backend-url">backend URL</label>
      <input
        id="backend-url"
        aria-describedby={error ? "backend-url-error" : undefined}
        class="mt-1 w-full rounded bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-indigo-500"
        placeholder="empty = same origin as this app"
        bind:value={url}
      />
      <p class="mt-1 text-xs text-zinc-600">
        {#if envBackendUrl}
          default from environment: <span class="text-zinc-400">{envBackendUrl}</span>
        {:else}
          leave empty to use the same origin as this app
        {/if}
        {#if !backendIsDefault()}
          — currently overridden: <span class="text-zinc-400">{backendBase() || "(same origin)"}</span>
        {/if}
      </p>
      {#if error}
        <p id="backend-url-error" role="alert" aria-live="assertive" class="mt-1 text-xs text-red-400">{error}</p>
      {/if}
      <p class="mt-1 text-xs text-zinc-600">changing this reloads the app.</p>
    </section>

    <!-- tools pointer -->
    <section class="mb-4">
      <h3 class="mb-1 text-xs uppercase tracking-wide text-zinc-500">tools</h3>
      <p class="text-xs text-zinc-600">
        per-chat tool settings (and "use as machine defaults") live in the right bar's ⚙ tool settings.
      </p>
    </section>

    <!-- diagnostics -->
    <section class="mb-2">
      <h3 class="mb-1 text-xs uppercase tracking-wide text-zinc-500">diagnostics</h3>
      <label class="flex items-center gap-2 text-xs text-zinc-400" for="log-level">
        log verbosity
        <select
          id="log-level"
          class="rounded bg-zinc-800 px-2 py-1 text-xs outline-none"
          bind:value={level}
          onchange={applyLevel}
        >
          {#each LEVELS as l (l)}
            <option value={l}>{l}</option>
          {/each}
        </select>
      </label>
      <p class="mt-1 text-xs text-zinc-600">
        "debug" prints live SSE events to the browser console; applies immediately.
      </p>
    </section>

    <div class="mt-4 flex justify-end gap-2">
      <button class="rounded px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200" onclick={close}>close</button>
      <button
        class="rounded bg-indigo-600 px-3 py-1.5 text-xs hover:bg-indigo-500 disabled:opacity-40"
        disabled={!changed}
        onclick={save}
      >
        save &amp; reload
      </button>
    </div>
  </div>
</div>
