<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { tick } from "svelte";

  let name = $state("");
  let credential = $state("");
  let mode = $state<"password" | "pin">("password");
  let error = $state<string | null>(null);
  let busy = $state(false);
  let credentialInput: HTMLInputElement;

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    busy = true;
    try {
      if (mode === "pin" && !/^\d{4,6}$/.test(credential)) {
        throw new Error("PIN must be 4-6 digits");
      }
      await app.login(name.trim(), credential);
      app.showLogin = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      await tick();
      credentialInput?.focus();
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex h-screen items-center justify-center">
  <form
    class="w-80 space-y-4 rounded-lg bg-zinc-900 p-6"
    aria-labelledby="login-title"
    aria-busy={busy}
    onsubmit={submit}
  >
    <h1 id="login-title" class="text-lg font-semibold">sign in to iris</h1>
    <label for="login-username" class="block text-sm">
      <span id="login-username-label" class="text-zinc-400">username</span>
      <input
        id="login-username"
        class="mt-1 w-full rounded bg-zinc-800 px-3 py-2 outline-none focus:ring-1 focus:ring-indigo-500"
        bind:value={name}
        autocomplete="username"
        aria-labelledby="login-username-label"
        required
      />
    </label>
    <label for="login-credential" class="block text-sm">
      <span id="login-credential-label" class="text-zinc-400">
        {mode === "pin" ? "PIN (4-6 digits)" : "password"}
      </span>
      <input
        id="login-credential"
        class="mt-1 w-full rounded bg-zinc-800 px-3 py-2 outline-none focus:ring-1 focus:ring-indigo-500"
        bind:value={credential}
        bind:this={credentialInput}
        type="password"
        inputmode={mode === "pin" ? "numeric" : undefined}
        autocomplete="current-password"
        required
        aria-labelledby="login-credential-label"
        aria-invalid={error ? "true" : undefined}
        aria-describedby={error ? "login-error" : undefined}
      />
    </label>
    <div class="flex gap-2 text-xs">
      <button
        type="button"
        class={`rounded px-2 py-1 ${mode === "password" ? "bg-indigo-600" : "bg-zinc-800"}`}
        aria-pressed={mode === "password"}
        onclick={() => (mode = "password")}>password</button
      >
      <button
        type="button"
        class={`rounded px-2 py-1 ${mode === "pin" ? "bg-indigo-600" : "bg-zinc-800"}`}
        aria-pressed={mode === "pin"}
        onclick={() => (mode = "pin")}>PIN</button
      >
    </div>
    {#if error}
      <p id="login-error" role="alert" aria-live="assertive" class="text-sm text-red-400">{error}</p>
    {/if}
    <button
      class="w-full rounded bg-indigo-600 py-2 font-medium hover:bg-indigo-500 disabled:opacity-50"
      disabled={busy}
      aria-busy={busy}
    >
      {busy ? "signing in…" : "sign in"}
    </button>
    <button
      type="button"
      class="w-full text-sm text-zinc-500 hover:text-zinc-300"
      onclick={() => (app.showLogin = false)}
    >
      continue as guest
    </button>
  </form>
</div>
