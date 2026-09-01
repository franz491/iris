# Iris frontend — state, API client, tool config

## Backend URL (lib/backend.ts)

Resolution: localStorage "iris.backendUrl" (SettingsModal) >
VITE_IRIS_BACKEND_URL build-time default > same origin. apiUrl() prefixes all
requests; changing it reloads the app (SSE + auth bind at startup).

## State store (lib/state.svelte.ts)

Single reactive `app` object: session (user/guest), chats, current chat
messages/participants/settings, SSE subscription with reconnect+backoff,
pending tool approval requests, aiCards, backendOnline probe.
Key flows:
- openChat seeds the chat's tool config from machine defaults on first open,
  then pushes the effective config to the backend per connection.
- pushToolConfigNow sends {tools, promptOverrides} (+ loadedTools via
  setChatLoadedTools) to PATCH /chats/:id/tool-config.

## Tool configuration model

- Machine defaults: localStorage iris.tools.defaults (template for new chats,
  also written by "use as defaults" in ToolSettingsModal).
- Per-chat overrides: localStorage iris.tools.chat.<id>; effective = override
  else defaults. Approval flags ride on group entries; shell mode lives in
  settings.mode (host/approval/docker_rw/docker_readonly).
- Loaded groups ("load tool documentation into the context") persist
  server-side in chat settings; read_tool_info is always loaded and lets the
  AI pull more docs itself.
- Frontend-tool doc overrides: localStorage iris.toolPrompts, pushed per
  connection; only frontend groups are accepted by the backend.

## Export/import

ToolSettingsModal exports/imports {kind:"iris.toolconfig", version:2,
tools, promptOverrides} — reusable across chats and machines. The admin CLI
exports/imports backend prompt overrides ({kind:"iris.prompts"}).
