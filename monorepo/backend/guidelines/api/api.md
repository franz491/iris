api.ts - holds the rest of the API

## ASSUMPTIONS
- Hono app exposing chat, polling, card, tool, and audio routes plus auth under
  `/api/auth/**`. Generic provider, plugin, and server audio-stream
  passthroughs are intentionally removed; see `docs/API_ROUTE_POLICY.md`.
- Creating user is auto-added to the new chat if no user participant supplied.
