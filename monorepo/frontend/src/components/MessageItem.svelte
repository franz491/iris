<script module lang="ts">
  import type { Message as MessageType } from "../lib/types";

  type ToolInfo = {
    fn: string;
    args: unknown;
    result: unknown;
    ok: boolean | null;
    playbackId?: string;
  };

  export function toolToggleLabel(functionName: string, expanded: boolean): string {
    return `${expanded ? "Collapse" : "Expand"} tool use ${functionName}`;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function hasError(value: unknown): boolean {
    return isRecord(value) && "error" in value;
  }

  function playbackIdOf(value: unknown): string | undefined {
    const playbackId = isRecord(value) ? value.playbackId : undefined;
    return typeof playbackId === "string" ? playbackId : undefined;
  }

  const MAX_TOOL_RESULT_JSON_LENGTH = 256 * 1024;

  function safeToolResult(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (!Array.isArray(value) && !isRecord(value)) return null;
    try {
      if (JSON.stringify(value).length > MAX_TOOL_RESULT_JSON_LENGTH) return null;
    } catch {
      return null;
    }
    return value;
  }

  function parseToolResultContent(value: unknown): unknown {
    if (typeof value !== "string" || value.length > MAX_TOOL_RESULT_JSON_LENGTH) return null;
    try {
      const parsed: unknown = JSON.parse(value);
      return safeToolResult(isRecord(parsed) && "result" in parsed ? parsed.result : value);
    } catch {
      return safeToolResult(value);
    }
  }

  function parseArguments(value: unknown): unknown {
    if (typeof value !== "string") return value ?? {};
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  export function getToolInfos(message: MessageType, pairedResults: MessageType[] = []): ToolInfo[] | null {
    if (message.type !== "tool" && message.type !== "tool_result") return null;

    try {
      const parsed: unknown = JSON.parse(message.content);
      if (message.type === "tool") {
        const calls = Array.isArray(parsed) ? parsed : [parsed];
        return calls.map((call, i) => {
          const callRecord = isRecord(call) ? call : {};
          const resultMessage = pairedResults[i];
          let result: unknown = null;
          let ok: boolean | null = null;
          if (resultMessage) {
            result = parseToolResultContent(resultMessage.content);
            ok = !hasError(result);
          }
          return {
            fn: typeof callRecord.name === "string" ? callRecord.name : "?",
            args: parseArguments(callRecord.arguments),
            result,
            ok,
            playbackId: playbackIdOf(result),
          };
        });
      }

      const resultRecord = isRecord(parsed) ? parsed : null;
      const result =
        resultRecord && "result" in resultRecord
          ? safeToolResult(resultRecord.result)
          : parseToolResultContent(message.content);
      return [
        {
          fn: resultRecord && typeof resultRecord.tool === "string" ? resultRecord.tool : "?",
          args: null,
          result,
          ok: resultRecord ? !hasError(result) : null,
          playbackId: playbackIdOf(result),
        },
      ];
    } catch {
      return [{ fn: message.type, args: message.content, result: null, ok: null }];
    }
  }
</script>

<script lang="ts">
  import type { Message } from "../lib/types";
  import { app } from "../lib/state.svelte";

  let { message }: { message: Message } = $props();

  import { identicon } from "../lib/identicon";
  import { markdownToHtml } from "../lib/markdown";
  import { api } from "../lib/api";
  import { indexParticipants } from "../lib/participant-index";

  let editing = $state(false);
  let editContent = $state("");
  let editThought = $state("");

  const participantById = $derived(indexParticipants(app.participants));
  const author = $derived(participantById.get(message.authorId));
  /** user pfps come from the participant record; AIs from their card seed */
  const avatar = $derived(
    author?.role === "user"
      ? (author.avatar ?? identicon(author.userId ?? author.name, 40))
      : identicon(author?.cardId ?? message.authorId, 40),
  );

  function startEdit() {
    editContent = message.content;
    editThought = message.thought;
    editing = true;
  }

  async function saveEdit() {
    await app.editMessage(message.id, { content: editContent, thought: editThought });
    editing = false;
  }

  const isAi = $derived(participantById.get(message.authorId)?.role === "ai");
  const whisperTo = $derived(
    message.to && message.to.length > 0 ? message.to.map((id) => app.participantName(id)).join(", ") : null,
  );
  const isFile = $derived(message.type === "file");
  /** tool-call / tool-result rows render as collapsible "Tool use" blocks */
  const isToolMsg = $derived(message.type === "tool" || message.type === "tool_result");
  let toolExpanded = $state(false);
  let expandedToolIndex = $state<number | null>(null);
  let replaying = $state<string | null>(null);
  async function replay(playbackId: string) {
    if (!app.currentChatId) return;
    replaying = playbackId;
    const player = new Audio();
    player.crossOrigin = "use-credentials";
    player.src = api.playbackAudioUrl(playbackId, app.currentChatId);
    try {
      await player.play();
    } finally {
      player.addEventListener(
        "ended",
        () => {
          replaying = null;
        },
        { once: true },
      );
      player.addEventListener(
        "error",
        () => {
          replaying = null;
        },
        { once: true },
      );
    }
  }
  /** index of this message in the chat; used to pair results with their call */
  const myIndex = $derived(app.messages.findIndex((m) => m.id === message.id));
  /** tool_result rows that directly follow this tool call (same author). */
  const pairedResults = $derived.by(() => {
    if (message.type !== "tool" || myIndex < 0) return [];
    const out: Message[] = [];
    for (let i = myIndex + 1; i < app.messages.length; i++) {
      const m = app.messages[i];
      if (m.type !== "tool_result" || m.authorId !== message.authorId) break;
      out.push(m);
    }
    return out;
  });
  const toolInfos = $derived.by(() => {
    if (!isToolMsg) return null;
    return getToolInfos(message, pairedResults);
  });
  const toolInfo = $derived((toolInfos ?? [])[0] ?? null);
  /** standalone tool_result rows are folded into their call's block */
  const isOrphanResult = $derived.by(() => {
    if (message.type !== "tool_result" || myIndex <= 0) return false;
    const prev = app.messages[myIndex - 1];
    return prev.type === "tool" && prev.authorId === message.authorId;
  });
  const fileName = $derived(message.content.replace(/^\[file\]\s*/, ""));
  const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
  const isImage = $derived(isFile && IMAGE_RE.test(fileName));
  let attachmentUrl = $state<string | null>(null);
  let attachmentError = $state(false);
  $effect(() => {
    const chatId = app.currentChatId;
    const name = fileName;
    if (!isFile || !chatId || !name) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    attachmentUrl = null;
    attachmentError = false;
    void api
      .downloadFile(chatId, name)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        attachmentUrl = objectUrl;
      })
      .catch((error) => {
        console.error("attachment download failed", error);
        if (!cancelled) attachmentError = true;
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  });
</script>

{#if !isOrphanResult}
  <div class="group flex max-w-3xl gap-3">
    <img src={avatar} alt="" class="mt-1 size-10 shrink-0 self-start rounded" />
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline gap-2 text-xs text-zinc-500">
        <span class={isAi ? "text-indigo-400" : "text-emerald-400"}>
          {app.participantName(message.authorId)}
        </span>
        <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
        {#if whisperTo}
          <span class="italic text-fuchsia-400/80">whisper to {whisperTo}</span>
        {/if}
        <span class="ml-auto hidden shrink-0 gap-2 group-hover:flex">
          <button class="text-zinc-600 hover:text-zinc-300" title="edit message" onclick={startEdit}>✎</button>
        </span>
      </div>

      {#if message.type === "compaction"}
        <p class="my-2 text-center text-xs text-zinc-600">— context compacted —</p>
      {:else if editing}
        <div class="mt-1 space-y-2 rounded bg-zinc-900 p-2">
          <textarea
            class="w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-400"
            rows="2"
            bind:value={editThought}
            placeholder="thought"></textarea>
          <textarea class="w-full rounded bg-zinc-800 px-2 py-1 text-sm" rows="3" bind:value={editContent}></textarea>
          <div class="flex justify-end gap-2 text-xs">
            <button class="rounded px-2 py-1 text-zinc-400 hover:text-zinc-200" onclick={() => (editing = false)}
              >cancel</button
            >
            <button class="rounded bg-indigo-600 px-2 py-1 hover:bg-indigo-500" onclick={() => void saveEdit()}
              >save &amp; branch</button
            >
          </div>
        </div>
      {:else if message.thought}
        <details class="mt-1 rounded bg-zinc-900/60 px-3 py-1 text-xs text-zinc-500">
          <summary class="cursor-pointer select-none hover:text-zinc-400">thought</summary>
          <p class="mt-1 whitespace-pre-wrap border-l border-zinc-700 pl-3">{message.thought}</p>
        </details>
      {/if}

      {#if !editing && isToolMsg && !isOrphanResult}
        {#each toolInfos ?? [] as info, i (i)}
          <button
            class="mt-1 flex w-full items-center gap-2 rounded border border-amber-800/50 bg-amber-950/30 px-2 py-1.5 text-left text-xs text-amber-200/90"
            aria-expanded={expandedToolIndex === i}
            aria-label={toolToggleLabel(info.fn, expandedToolIndex === i)}
            onclick={() => (expandedToolIndex = expandedToolIndex === i ? null : i)}
          >
            <span class="font-semibold uppercase tracking-wide">tool use</span><span class="font-mono">{info.fn}</span>
            {#if info.ok !== null && info.ok !== undefined}<span class={info.ok ? "text-emerald-400" : "text-red-400"}
                >{info.ok ? "✓ ok" : "✗ failed"}</span
              >{/if}
            <span class="ml-auto text-zinc-500">{expandedToolIndex === i ? "▾" : "▸"}</span>
          </button>
          {#if info.playbackId}
            <button
              class="mt-1 rounded bg-indigo-700 px-2 py-1 text-xs text-white disabled:opacity-50"
              disabled={replaying === info.playbackId}
              onclick={() => void replay(info.playbackId!)}
              >{replaying === info.playbackId ? "Playing…" : "▶ Replay audio"}</button
            >
          {/if}
          {#if expandedToolIndex === i}
            <div
              class="space-y-1 rounded-b border border-t-0 border-amber-800/40 bg-zinc-950/60 p-2 font-mono text-xs text-zinc-400"
            >
              {#if info.args !== null && info.args !== undefined}
                <div>
                  <span class="text-zinc-600">arguments:</span>
                  <pre class="whitespace-pre-wrap">{JSON.stringify(info.args, null, 2)}</pre>
                </div>
              {/if}
              {#if info.result !== null && info.result !== undefined}
                <div>
                  <span class="text-zinc-600">result:</span>
                  <pre class="max-h-64 overflow-y-auto whitespace-pre-wrap">{JSON.stringify(info.result, null, 2)}</pre>
                </div>
              {/if}
            </div>
          {/if}
        {/each}
      {:else if !editing}
        <div class="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-200">
          {#if isFile}
            {#if isImage}
              {#if attachmentUrl}
                <a href={attachmentUrl} target="_blank" rel="noopener">
                  <img src={attachmentUrl} alt={fileName} class="max-w-sm rounded" />
                </a>
              {:else if attachmentError}
                <span class="text-red-400">image unavailable: {fileName}</span>
              {:else}
                <span class="text-zinc-500">loading image…</span>
              {/if}
            {:else}
              {#if attachmentUrl}
                <a class="text-indigo-400 underline hover:text-indigo-300" href={attachmentUrl} download={fileName}>
                  📄 {fileName}
                </a>
              {:else if attachmentError}
                <span class="text-red-400">file unavailable: {fileName}</span>
              {:else}
                <span class="text-zinc-500">loading file…</span>
              {/if}
            {/if}
          {:else if message.content.trim().length > 0}
            {@html markdownToHtml(message.content)}
          {:else}
            <span class="italic text-zinc-600">*empty message*</span>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}
