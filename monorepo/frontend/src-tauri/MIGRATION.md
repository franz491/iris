# Tauri migration — plan & status

Goal: ship the Iris frontend as a desktop app so AI tools (shell, file
editing) execute natively on the user's machine, with the safety ladder
enforced client-side.

## What exists already

- `src/lib/tools.ts` defines `executeClientTool(tool, args)` — the single
  choke-point for client-side tool execution. The browser build proxies what
  it can to the backend and errors on native-only tools.
- Backend tool loop (`chat/tools.ts` + `chat.ts`) is executor-agnostic: tools
  are either provider-flavored or frontend-flavored, so swapping the FE
  executor changes nothing for the AI.

## Migration steps (in order)

1. **Scaffold**: `src-tauri/` skeleton committed (Cargo.toml, tauri.conf.json,
   main.rs). Requires Rust toolchain (`cargo --version`) to build — not yet
   present on this machine, so nothing compiles yet.
2. **Commands to implement** in Rust:
   - `tool_shell_oneshot(command, use_sudo, docker_image)` — plain process or
     docker run; maps to safety levels "host"/"docker_rw"/"docker_readonly".
   - `tool_shell_interactive(command)` — PTY session (recommend `portable-pty`
     crate), exposed to the bottom-panel terminal via Tauri events.
   - `tool_file_read(path)` / `tool_file_write(path, content)` with a root
     folder jail (no symlink traversal, mirroring backend rules).
3. **FE switch**: `executeClientTool` detects Tauri
   (`"__TAURI_INTERNALS__" in window`) and routes tools through
   `invoke("tool_*")` instead of backend proxying. No other FE changes.
4. **Approval flow**: unchanged — the approval modal already gates every
   `requiresApproval` tool regardless of executor.
5. **Packaging**: `pnpm tauri dev` / `pnpm tauri build`; add `@tauri-apps/cli`
   as devDependency when starting step 1 builds.

## Safety ladder mapping (client side)

| level | execution |
|---|---|
| free | direct process spawn |
| approval-each | modal per command, then direct spawn |
| docker-sudo | `docker run --rm -v $HOME/iris-shell:/sandbox -u root ...` |
| docker-user | same without `-u root` |

Levels are part of the machine-local tool settings (localStorage), consistent
with "same profile, different machines, different safety".
