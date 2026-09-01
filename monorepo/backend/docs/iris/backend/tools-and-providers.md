# Iris backend — tools & providers

## Tool groups (AI-facing)

`src/chat/tools.ts` defines TOOL_GROUPS. Each group has:
- `name`: internal key; `aiName`: name shown to the AI
- `backend: true` groups get the `backend_` prefix on their function schemas
  (backend_files, backend_shell, backend_docs) and run server-side via
  providers. They are opt-in ("seldom shown"); their tool.md prompts instruct
  the AI to prefer local versions unless explicitly asked.
- unprefixed groups (files, shell, docs, audio, memory) are FRONTEND-flavored
  or always-on:
  - files/shell/docs/audio: executed genuinely locally by the user's desktop
    client (Tauri). The backend sends SSE tool_request events and waits for
    POST /chats/:id/tool-response.
  - memory: always-on, executed server-side by the memory provider.
- read_tool_info is ALWAYS loaded: the AI calls it with a list of tool names
  to load additional groups' docs + schemas into the conversation. Loading is
  persisted per chat (settings.loadedTools).

Unloaded/inactive calls fail with "The tool specified does not exist or isn't
active in this chat".

## Providers & kernel

`src/providers/installed/*.ts` implement provider functionalities dispatched
through the kernel (`src/runtime/kernel.ts`, useProvider(name, fn, kwargs)).
Provider configs live in the config DB, bootstrapped from
`<dataDir>/config.yaml` — see docs/config.md and misc/config.example.yaml.

- files: sandboxed folder ops (create/read/search_and_replace/edit/edit_lines)
  + docker-backed shell. Symlink-traversal safe.
- shell: shell_oneshot / shell_interactive (PTY sessions).
- docs: read-only topic folders under docs/ with size-capped searches.
- memory: chat-scoped long-term memory (chatId injected by the tool loop).
- audio: pluggable backend descriptor (actual audio runs client-side now).
- search: DuckDuckGo HTML scrape (currently NOT exposed as an AI tool —
  removed as fragile).

The frontend must never execute backend groups; when the backend detects a
backend_* call it executes it itself, appends the result, and continues
generation.
