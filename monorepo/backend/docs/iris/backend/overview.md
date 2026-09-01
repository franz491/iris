# Iris backend — overview

Node 22 + TypeScript (ESM), pnpm monorepo at `monorepo/` with two packages:
`backend/` and `frontend/`.

- Hono HTTP server (@hono/node-server), default port 3000 (`IRIS_PORT`).
- SQLite via better-sqlite3 + drizzle-orm; DBs live under `<dataDir>/`
  (`IRIS_DATA_DIR`, default `./data`): chat.db, memory.db, prompts.db,
  keys.db, config.db, auth.db.
- Auth: BetterAuth (cookie sessions); users are `<name>@iris.local`,
  registered by the admin CLI on the server machine. Unauthenticated callers
  are guests sharing one identity.
- Entry point: `src/index.ts`. NOTE: auth routes are served by a separate
  Hono app mounted before the main one (Hono 4.13 trie bug workaround) — do
  not merge them back.
- Env: IRIS_PORT, IRIS_DATA_DIR, IRIS_PUBLIC_URL, IRIS_TRUSTED_ORIGINS
  (comma list; also drives CORS), IRIS_GUEST_AI_NAME, IRIS_GUEST_MODEL,
  IRIS_DEFAULT_MODEL, IRIS_OPENAI_COMPAT_BASE_URL/_API_KEY,
  IRIS_GUEST_CHAT_KEEP, IRIS_FILES_ROOT (frontend Tauri).

Runtime safety limits are centrally parsed and frozen at startup. The existing
defaults are preserved; operators may override them with validated, clamped
integer values using `IRIS_MAX_JSON_BODY_BYTES`, `IRIS_JSON_BODY_TIMEOUT_MS`,
`IRIS_MAX_ATTACHMENT_BYTES`, `IRIS_MAX_AUDIO_HANDLE_BYTES`, `IRIS_MAX_STT_BYTES`,
`IRIS_MAX_OPENAI_STREAM_BYTES`, `IRIS_MAX_OPENAI_SSE_LINE_BYTES`,
`IRIS_MAX_TOOL_ARGUMENT_BYTES`, `IRIS_MAX_TOOL_ARGUMENT_DEPTH`,
`IRIS_MAX_TOOL_ARGUMENT_FIELDS`, `IRIS_MAX_TOOL_RESULT_BYTES`,
`IRIS_MAX_TOOL_STORAGE_BYTES`, `IRIS_MAX_SEARCH_RESPONSE_BYTES`,
`IRIS_MAX_TTS_ERROR_BYTES`, `IRIS_MAX_TRANSIENT_AUDIO_ENTRIES`,
`IRIS_MAX_TRANSIENT_AUDIO_BYTES`, `IRIS_MAX_COMFY_JSON_DEPTH`,
`IRIS_MAX_COMFY_JSON_KEYS`, and `IRIS_MAX_COMFY_JSON_STRING_BYTES`. Malformed
or non-finite configured values fail closed during runtime-limit construction;
the legacy `jsonBodyTimeoutMs(value)` helper retains its fallback behavior for
callers that pass an explicit value.

Admission and abuse controls are also runtime-configurable through
`IRIS_MAX_ACTIVE_MODEL_REQUESTS`, `IRIS_MAX_ACTIVE_CREDENTIAL_OPERATIONS`,
`IRIS_MAX_ACTIVE_CONFIG_OPERATIONS`, `IRIS_LIMITER_KEY_CAPACITY`,
`IRIS_UPLOAD_LIMIT_PER_WINDOW`, `IRIS_GUEST_ACCESS_LIMIT_PER_WINDOW`,
`IRIS_GUEST_MESSAGE_LIMIT_PER_WINDOW`, `IRIS_SERVICE_PROBE_LIMIT_PER_WINDOW`,
and `IRIS_ABUSE_WINDOW_MS`. These preserve existing defaults while applying
the same strict parsing and clamped bounds. They are process-local controls and
do not provide distributed coordination.

`IRIS_CHAT_INSTANCE_CACHE_ENTRIES` bounds retained idle chat instances (default
256, clamped to 16–4096). Instances with subscribers, active generations,
frontend-tool waits, or in-flight operations are never evicted; an over-bound
cache is trimmed when one becomes idle.

`IRIS_CHAT_TOOL_CONFIG_ENTRIES` bounds ephemeral frontend-tool advertisements
per chat (default 256, clamped to 16–4096). Existing client advertisements are
never displaced when the bound is reached; new clients are rejected until a
disconnect removes an entry.

`pnpm test:property` runs the dependency-free IRIS-012 boundary corpus. It uses
a fixed seed and bounded cases for URL decoding/multiplicity, JSON declaration
and chunk probes, and limiter acquire/release invariants, so failures are
repeatable and do not depend on machine timing.

Key subsystems (each has its own doc in this folder):

- chat-system.md — chats, participants, messages, the reply protocol
- tools-and-providers.md — tool groups, providers, kernel dispatch
- memory.md — long-term memory feature
- prompts-and-cli.md — prompt library + admin CLI
- api.md — HTTP/SSE surface
- admin-control-plane.md — planned remote admin GUI, external runtime
  orchestration, profiles, TLS, audio/TTS/STT, and AI-assisted setup

Model routing: OpenAI-compatible endpoints; llama.cpp works out of the box
(default http://localhost:8080/v1). Named API keys are stored in keys.db and
referenced by name from AI participants.
