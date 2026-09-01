<script lang="ts">
  import { app } from "../lib/state.svelte";
  import MessageItem from "./MessageItem.svelte";
  import LiveReply from "./LiveReply.svelte";
  import { pastedImage } from "../lib/clipboard";
  import { historyWindow } from "../lib/history-window";

  let draft = $state("");
  let busy = $state(false);
  let fileInput = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let showWhisperPicker = $state(false);
  let mentionQuery = $state("");
  let uploadState = $state<"idle" | "uploading" | "complete" | "cancelled" | "error">("idle");
  let uploadController = $state<AbortController | null>(null);
  let uploadGeneration = 0;
  let uploadError = $state(false);
  let historyExpanded = $state(false);
  let windowChatId = $state<string | null>(null);

  /** whisper targets: everyone in the chat except me */
  const whisperTargets = $derived(app.participants.filter((p) => !(p.role === "user" && p.userId === app.myId)));

  /** targets matching the @token currently being typed */
  const filteredTargets = $derived(whisperTargets.filter((p) => p.name.toLowerCase().startsWith(mentionQuery)));
  const renderedMessages = $derived(historyWindow(app.messages, historyExpanded));

  $effect(() => {
    const chatId = app.currentChatId;
    if (windowChatId !== chatId) {
      windowChatId = chatId;
      historyExpanded = false;
    }
  });

  function showEarlierLoaded() {
    historyExpanded = true;
    queueMicrotask(() => listEl?.focus());
  }

  /**
   * Show the picker only while the cursor sits inside an @token (the "@" and
   * any following non-space characters). Any event that detaches the cursor
   * from it — space, paste containing a space, arrows/click moving past it —
   * recomputes this and hides the picker.
   */
  function updateMentionState() {
    const el = textarea;
    const pos = el?.selectionStart ?? -1;
    const m = pos >= 0 ? draft.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/) : null;
    if (m) {
      mentionQuery = m[1].toLowerCase();
      showWhisperPicker = true;
    } else {
      showWhisperPicker = false;
    }
  }

  /** complete the @token under the cursor with the chosen username */
  function pickMention(name: string) {
    const el = textarea;
    const pos = el?.selectionStart ?? -1;
    const m = pos >= 0 ? draft.slice(0, pos).match(/(?:^|\s)@([^\s@]*)$/) : null;
    if (!m || !el) return;
    const start = pos - m[1].length - 1; // index of the "@"
    draft = draft.slice(0, start) + `@${name} ` + draft.slice(pos);
    const caret = start + name.length + 2;
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
      updateMentionState(); // token closed with a space -> picker hides
    });
  }

  // stick to bottom only while the user is near it (prevents yanking the
  // viewport when older messages are prepended)
  let stickToBottom = $state(true);
  function onListScroll() {
    if (!listEl) return;
    stickToBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 120;
  }
  $effect(() => {
    void app.messages.length;
    void app.live?.thought;
    void app.live?.content;
    if (stickToBottom)
      requestAnimationFrame(() => requestAnimationFrame(() => listEl?.scrollTo({ top: listEl.scrollHeight })));
  });

  /** prepend history while keeping the current content in view */
  async function loadOlderAnchored() {
    const el = listEl;
    if (!el) return void app.loadOlder();
    const delta = el.scrollHeight - el.scrollTop;
    await app.loadOlder();
    queueMicrotask(() => el.scrollTo({ top: Math.max(0, el.scrollHeight - delta) }));
    stickToBottom = false;
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    busy = true;
    try {
      await app.send(text);
      draft = "";
      showWhisperPicker = false;
    } catch (e) {
      console.error(e);
    } finally {
      busy = false;
    }
  }

  function cancelUpload() {
    uploadController?.abort();
  }

  async function uploadBlob(file: Blob, filename: string) {
    if (!app.currentChatId || uploadController) return;
    const controller = new AbortController();
    const generation = ++uploadGeneration;
    uploadController = controller;
    busy = true;
    uploadState = "uploading";
    uploadError = false;
    try {
      await app.uploadFile(app.currentChatId, filename, file, controller.signal);
      if (generation !== uploadGeneration || uploadController !== controller) return;
      uploadState = "complete";
      showWhisperPicker = false;
    } catch (err) {
      if (generation !== uploadGeneration || uploadController !== controller) return;
      if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError"))
        uploadState = "cancelled";
      else {
        uploadState = "error";
        uploadError = true;
        console.error("upload failed", err);
      }
    } finally {
      if (generation === uploadGeneration && uploadController === controller) {
        uploadController = null;
        busy = false;
      }
    }
  }

  async function upload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) await uploadBlob(file, file.name);
    input.value = "";
  }

  async function paste(e: ClipboardEvent) {
    const image = pastedImage(e.clipboardData);
    if (!image || !app.currentChatId || busy || uploadController) return;
    e.preventDefault();
    await uploadBlob(image.file, image.filename);
  }
</script>

<div class="flex min-h-0 flex-1 flex-col">
  {#if app.isGuest() && app.currentChatId === app.guestChatId}
    <div
      class="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-4 py-1 text-xs text-zinc-500"
    >
      <span>universal guest chat — everyone shares this conversation</span>
      <button
        class="rounded px-2 py-0.5 text-red-400/80 hover:bg-zinc-800 hover:text-red-300"
        onclick={() => void app.clearCurrentContext()}
      >
        delete context
      </button>
    </div>
  {/if}
  <div
    bind:this={listEl}
    onscroll={onListScroll}
    tabindex="-1"
    aria-label="Chat message history"
    class="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
  >
    {#if renderedMessages.hidden > 0}
      <div class="flex justify-center py-2">
        <button
          class="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-700"
          aria-label={`Show ${renderedMessages.hidden} earlier loaded messages`}
          aria-controls="chat-message-list"
          onclick={showEarlierLoaded}
        >
          show earlier loaded messages ({renderedMessages.hidden})
        </button>
      </div>
    {/if}
    {#if app.hasMoreHistory}
      <div class="flex justify-center py-2">
        <button
          class="rounded bg-zinc-800 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-700 disabled:opacity-50"
          disabled={app.loadingOlder}
          aria-busy={app.loadingOlder}
          onclick={() => void loadOlderAnchored()}
        >
          {app.loadingOlder ? "loading…" : "load older messages"}
        </button>
      </div>
    {/if}
    <div id="chat-message-list">
      {#each renderedMessages.visible as m (m.id)}
        <MessageItem message={m} />
      {:else}
        <p class="pt-10 text-center text-sm text-zinc-600">no messages yet — say something</p>
      {/each}
    </div>
    <LiveReply />
  </div>

  <div class="border-t border-zinc-800 p-3">
    <div class="relative">
      {#if showWhisperPicker}
        <div class="absolute bottom-full left-0 z-10 mb-2 w-64 rounded border border-zinc-700 bg-zinc-900 shadow-xl">
          <p class="border-b border-zinc-800 px-3 py-1.5 text-xs text-zinc-500">whisper to… (@mentions)</p>
          {#each filteredTargets as p (p.id)}
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-zinc-300 hover:bg-zinc-800"
              onclick={() => pickMention(p.name)}
            >
              <span class="flex-1 truncate">{p.role === "ai" ? "🤖" : "👤"} {p.name}</span>
            </button>
          {:else}
            <p class="px-3 py-2 text-xs text-zinc-600">
              {whisperTargets.length === 0 ? "no one else is in this chat" : "no matching user"}
            </p>
          {/each}
        </div>
      {/if}
      <div class="flex items-end gap-2">
        <button
          class="rounded px-3 py-2 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
          title="attach file"
          aria-label="Attach file"
          disabled={busy || uploadController !== null}
          onclick={() => fileInput?.click()}
        >
          📎
        </button>
        <input
          aria-label="Upload attachment"
          bind:this={fileInput}
          type="file"
          class="hidden"
          onchange={upload}
          disabled={busy}
        />
        <textarea
          class="max-h-40 min-h-[2.5rem] flex-1 resize-none rounded bg-zinc-800 px-3 py-2 outline-none focus:ring-1 focus:ring-indigo-500"
          placeholder="message… (Enter to send, Shift+Enter for newline, @ to whisper)"
          bind:value={draft}
          bind:this={textarea}
          oninput={updateMentionState}
          onkeyup={updateMentionState}
          onclick={updateMentionState}
          onpaste={(e) => void paste(e)}
          onkeydown={(e) => {
            if (e.key === "Escape") showWhisperPicker = false;
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}></textarea>
        <button
          class="rounded bg-indigo-600 px-4 py-2 hover:bg-indigo-500 disabled:opacity-50"
          disabled={busy || !draft.trim()}
          onclick={() => void send()}
        >
          send
        </button>
        {#if uploadController}
          <button
            class="rounded px-2 py-2 text-xs text-red-300 hover:bg-zinc-800"
            aria-label="Cancel upload"
            onclick={cancelUpload}
          >
            cancel
          </button>
        {/if}
      </div>
      <p class="sr-only" role="status" aria-live="polite">
        {uploadState === "uploading"
          ? "Uploading attachment"
          : uploadState === "complete"
            ? "Attachment uploaded"
            : uploadState === "cancelled"
              ? "Upload cancelled"
              : ""}
      </p>
      {#if uploadError}<p role="alert" aria-live="assertive" class="text-xs text-red-300">
          Upload failed. Try again.
        </p>{/if}
    </div>
  </div>
</div>
