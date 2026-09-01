# Iris frontend — Tauri integration & local tools

## Rust side (`src-tauri/src/`)

- main.rs registers commands + plugins (shell, fs) and the capability file
  `capabilities/default.json` (core:default + shell:allow-open). Tauri v2
  DENIES plugin commands without a capability — plugins.shell.open in
  tauri.conf.json is only URL validation, not a permission.
- filejail.rs — jailed sandboxed folder (IRIS_FILES_ROOT, default ./files):
  tool_file_read / tool_file_write. Rejects absolute paths, "..", symlinks.
- shell.rs — shell execution with safety modes:
  host | approval | docker_rw | docker_readonly (tool_shell_oneshot), plus
  interactive PTY sessions (tool_shell_interactive/write/close).
- docs.rs — read-only jailed docs root (IRIS_DOCS_ROOT, default ./docs):
  topics = folders; structure trees; case-insensitive + regex search with
  size caps and allow_large_output head|tail|all.
- audio.rs — cpal devices: tool_audio_devices / tool_audio_play (base64 WAV,
  blocking) / tool_audio_read (N seconds -> mono 16-bit base64 WAV).

Dependencies added beyond tauri defaults: regex, cpal, hound, base64.

## Local tool executor (lib/tools.ts executeClientTool)

Executes the AI's FRONTEND tool functions genuinely locally (never proxies to
the backend): shell_exec, files ops (edit_file/search_and_replace/edit_lines
are JS transforms over the jailed read/write), docs_* via Rust commands,
audio_* via Rust commands. Requires the desktop app; browsers get an error.
Backend groups are NEVER executed here — the server runs them itself.

## External links

Capture-phase click handler: any link resolving outside the app origin opens
in the system browser via plugin:shell|open (fallback window.open);
same-origin links stay in the webview so downloads/images work.
