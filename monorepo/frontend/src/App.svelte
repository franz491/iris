<script lang="ts">
  import { onMount } from "svelte";
  import { pushToast } from "./lib/toasts.svelte";

  async function retry() {
    await app.checkBackend();
    await app.init();
    if (app.backendOnline) pushToast("info", "connected");
    else pushToast("warn", "still unreachable");
  }
  import { app } from "./lib/state.svelte";
  import { apiUrl } from "./lib/backend";
  import LoginScreen from "./components/LoginScreen.svelte";
  import NewChatModal from "./components/NewChatModal.svelte";
  import NewAiCardModal from "./components/NewAiCardModal.svelte";
  import ToolApprovalModal from "./components/ToolApprovalModal.svelte";
  import AdminControlPlane from "./components/AdminControlPlane.svelte";
  import Toasts from "./components/Toasts.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import LeftBar from "./components/LeftBar.svelte";
  import TopTools from "./components/TopTools.svelte";
  import RightBar from "./components/RightBar.svelte";
  import BottomPanel from "./components/BottomPanel.svelte";
  import ChatView from "./components/ChatView.svelte";
  import { isBootstrapStatus } from "./lib/schema";

  // Keep routing in Svelte state.  `location.pathname` is not reactive and
  // Tauri can reject a full-page navigation to an absolute `/admin` URL.
  let pathname = $state(location.pathname);
  const navigate = (path: string) => {
    history.pushState({}, "", path);
    pathname = path;
  };

  // Keep this available even when bootstrap probing fails.  In Tauri a normal
  // absolute-page navigation can leave the webview on an error page, so this
  // must use the same in-app history navigation as the automatic redirect.
  const openAdmin = () => navigate("/admin");

  onMount(() => {
    const onPopState = () => (pathname = location.pathname);
    addEventListener("popstate", onPopState);
    void (async () => {
      try {
        const response = await fetch(`${apiUrl("/api")}/admin/bootstrap/status`, { credentials: "include" });
        const state: unknown = await response.json();
        if (response.ok && isBootstrapStatus(state) && state.configured === false && pathname !== "/admin") {
          navigate("/admin");
          return;
        }
      } catch {}
      await app.init();
      const chatId = new URLSearchParams(location.search).get("chat");
      if (chatId) {
        await app.openChat(chatId);
        history.replaceState({}, "", location.pathname);
      }
    })();
    return () => removeEventListener("popstate", onPopState);
  });
</script>

{#if pathname === "/admin"}
  <AdminControlPlane />
{:else}
  {#if !app.backendOnline && app.session.kind === "loading"}
    <div class="flex h-screen flex-col items-center justify-center gap-4">
      <p class="text-lg text-zinc-300" role="status" aria-live="polite">backend is not running</p>
      <button class="rounded border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800" onclick={openAdmin}>
        open admin setup
      </button>
      <button class="rounded bg-indigo-600 px-4 py-2 hover:bg-indigo-500" onclick={retry}>retry</button>
    </div>
  {:else if app.session.kind === "loading"}
    <div class="flex h-screen items-center justify-center text-zinc-500">loading…</div>
  {:else if !app.backendOnline}
    <div class="flex h-screen flex-col items-center justify-center gap-4">
      <p class="text-lg text-zinc-300" role="status" aria-live="polite">backend is not running</p>
      <p class="max-w-md text-center text-sm text-zinc-500">start the backend server, then retry</p>
      <button class="rounded border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800" onclick={openAdmin}>
        open admin setup
      </button>
      <button
        class="rounded bg-indigo-600 px-4 py-2 hover:bg-indigo-500"
        onclick={async () => {
          if (await app.checkBackend()) {
            await app.init();
          } else {
            pushToast("warn", "still offline");
          }
        }}
      >
        retry
      </button>
    </div>
  {:else if app.showLogin}
    <LoginScreen />
  {:else}
    <div class="flex h-screen flex-col">
      <TopTools />
      <div class="flex min-h-0 flex-1">
        {#if app.leftOpen}
          <LeftBar />
        {/if}
        <main class="flex min-w-0 flex-1 flex-col">
          {#if app.currentChatId}
            <ChatView />
          {:else}
            <div class="flex flex-1 items-center justify-center text-zinc-600">
              <div class="text-center">
                {#if !app.backendOnline || (app.isGuest() && app.guestChatFailed)}
                  <p class="text-zinc-300" role="status" aria-live="polite">server unreachable</p>
                  <button
                    class="mt-3 rounded border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
                    onclick={openAdmin}
                  >
                    open admin setup
                  </button>
                  <button class="mt-3 rounded bg-indigo-600 px-4 py-2 hover:bg-indigo-500" onclick={() => void retry()}>
                    retry
                  </button>
                {:else if app.isGuest()}
                  <p>guests share the universal chat</p>
                {:else}
                  <button
                    class="mt-3 rounded bg-indigo-600 px-4 py-2 hover:bg-indigo-500"
                    onclick={() => (app.showNewChat = true)}
                  >
                    new chat
                  </button>
                {/if}
              </div>
            </div>
          {/if}
          {#if app.bottomOpen}
            <BottomPanel />
          {/if}
        </main>
        {#if app.rightOpen}
          <RightBar />
        {/if}
      </div>
    </div>
  {/if}

  {#if app.showNewChat}
    <NewChatModal />
  {/if}

  {#if app.showSettings}
    <SettingsModal close={() => (app.showSettings = false)} />
  {/if}

  {#if app.showNewAiCard}
    <NewAiCardModal />
  {/if}

  <Toasts />
  <ToolApprovalModal />
{/if}
