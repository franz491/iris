# Iris frontend — overview

Svelte 5 (runes) + Vite + Tailwind v4, packaged as a Tauri 2 desktop app
(`src-tauri/`). Talks to the backend same-origin via /api (Vite dev proxy) or
to a remote backend origin (settings modal; see state-and-api.md).

## Layout

- `src/main.ts` — entrypoint; installs the external-link handler.
- `src/App.svelte` — shell: LeftBar (chats), ChatView, RightBar, BottomPanel,
  Toasts, modals (NewChatModal, NewAiCardModal, EditCardModal,
  SettingsModal, ToolSettingsModal, ToolApprovalModal).
- `src/lib/state.svelte.ts` — the app store (Svelte runes): chats, messages,
  participants, SSE subscription, tool config push, toasts.
- `src/lib/api.ts` — typed fetch wrappers; always sends credentials so a
  cross-origin backend works.
- `src/lib/backend.ts` — backend URL resolution + BetterAuth client.
- `src/lib/tools.ts` — tool catalog, machine-local settings, and the local
  (Tauri) tool executor.
- `src/components/` — one file per UI piece.

## Key behaviors

- All links whose origin differs from the app open in the system browser
  (capture-phase handler, lib/externalLinks.ts); same-origin /api files stay
  in-app. Downloads/images render inline.
- Tool use renders as collapsible amber "Tool use" blocks in MessageItem:
  function name + success/failure collapsed; arguments + result on expand.
- SSE with auto-reconnect + capped backoff; re-polls history on reconnect.
  Toasts surface connection loss/restoration and compaction events.

Sub-pages: components.md, state-and-api.md, tauri.md.
