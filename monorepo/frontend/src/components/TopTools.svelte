<script lang="ts">
  import { onDestroy } from "svelte";
  import { app } from "../lib/state.svelte";
  import { identicon } from "../lib/identicon";

  let fileInput = $state<HTMLInputElement | null>(null);
  let error = $state<string | null>(null);
  let profileState = $state<"idle" | "uploading" | "complete" | "cancelled">("idle");
  let profileReader = $state<FileReader | null>(null);
  let profileGeneration = 0;

  const myAvatar = $derived(
    app.session.kind === "user" ? (app.myImage ?? identicon(app.myId ?? app.session.name, 32)) : null,
  );

  async function onFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = "";
    if (file.size > 190 * 1024) {
      error = "image too large (max ~190KB)";
      return;
    }
    error = null;
    profileState = "uploading";
    const generation = ++profileGeneration;
    try {
      const reader = new FileReader();
      profileReader = reader;
      reader.onload = () => {
        if (generation !== profileGeneration || profileReader !== reader) return;
        profileState = "complete";
        profileReader = null;
        void app.setMyImage(String(reader.result));
      };
      reader.onabort = () => {
        if (generation !== profileGeneration || profileReader !== reader) return;
        profileState = "cancelled";
        profileReader = null;
      };
      reader.onerror = () => {
        if (generation !== profileGeneration || profileReader !== reader) return;
        profileState = "idle";
        error = "profile image could not be read";
        profileReader = null;
      };
      reader.readAsDataURL(file);
    } catch (err) {
      profileReader = null;
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function cancelProfileUpload() {
    profileGeneration++;
    profileReader?.abort();
    profileReader = null;
    profileState = "cancelled";
  }

  onDestroy(() => {
    profileGeneration++;
    profileReader?.abort();
    profileReader = null;
  });
</script>

<header class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-2">
  <div class="flex items-center gap-2">
    <button
      class="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      title="toggle chat list"
      onclick={() => (app.leftOpen = !app.leftOpen)}
    >
      ☰
    </button>
    <button
      class="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      title="toggle bottom panel"
      onclick={() => (app.bottomOpen = !app.bottomOpen)}
    >
      ▤
    </button>
    <button
      class="rounded px-2 py-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      title="toggle right sidebar"
      onclick={() => (app.rightOpen = !app.rightOpen)}
    >
      ▥
    </button>
  </div>
  <div class="flex items-center gap-3 text-sm">
    {#if app.session.kind === "user"}
      {#if app.isAdmin}
        <a class="rounded bg-indigo-950 px-2 py-1 text-indigo-300 hover:bg-indigo-900" href="/admin">Admin</a>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span class="flex items-center gap-2 text-zinc-400">
        <button
          class="contents"
          title="change profile picture"
          aria-label="Change profile picture"
          onclick={() => fileInput?.click()}
        >
          <img src={myAvatar} alt="" class="size-7 rounded hover:ring-2 hover:ring-indigo-500" />
        </button>
        {app.session.name}
      </span>
      <input
        aria-label="Upload profile picture"
        bind:this={fileInput}
        type="file"
        accept="image/*"
        class="hidden"
        onchange={onFile}
      />
      {#if profileReader}
        <button
          class="text-xs text-red-300 hover:text-red-200"
          aria-label="Cancel profile image upload"
          onclick={cancelProfileUpload}
        >
          cancel upload
        </button>
      {/if}
      <button class="text-zinc-500 hover:text-zinc-300" onclick={() => void app.logout()}>log out</button>
    {:else}
      <span class="text-zinc-600">guest</span>
      <button class="text-indigo-400 hover:text-indigo-300" onclick={() => (app.showLogin = true)}> sign in </button>
    {/if}
  </div>
</header>
{#if error}
  <p class="bg-red-900/40 px-3 py-1 text-xs text-red-300" role="alert" aria-live="assertive">{error}</p>
{/if}
<p class="sr-only" role="status" aria-live="polite">
  {profileState === "uploading"
    ? "Uploading profile image"
    : profileState === "complete"
      ? "Profile image uploaded"
      : profileState === "cancelled"
        ? "Profile image upload cancelled"
        : ""}
</p>
