# Iris backend — HTTP/SSE API surface

All routes live under /api. Auth: BetterAuth cookie sessions (/api/auth/**,
served by a dedicated Hono app). Unauthenticated callers are guests; guests
share one identity and can only access chats without registered users (their
own universal guest chat via GET /api/chats/guest).

Chats & messages:
- POST /chats — create (registered users only)
- GET/PATCH/DELETE /chats/:id — fetch/rename/delete (member-gated)
- GET /chats/guest — universal guest chat (find-or-create)
- POST /chats/:id/messages — send (text/file; optional to[] participant ids for whispers; resolved @username tags anywhere set recipients and remain visible)
- PUT /files/chats/:id/:filename — upload a chat attachment and atomically
  create its file message; GET serves it with its media MIME type. Both are
  membership-gated.
- POST /chats/:id/stop — stop generating AI(s) ({participantId?}; save truncated reply + restart)
- PATCH/DELETE /chats/:id/messages/:mid — edit / truncate-from
- GET /chats/:id/history?before=&limit= — paged history
- GET /chats/:id/participants, POST .../participants — list/add members/AIs
- PATCH /chats/:id/settings — boolean whitelist: userInterruptions,
  aiInterruptions, forceAiReply
- DELETE /chats/:id/context — wipe messages + compaction state

Live:
- GET /chats/:id/stream — SSE. The server sends an initial `connected` event,
  recipient-filters finalized messages and branch rewrites, and scopes tool
  requests to the authenticated user and client ID. Raw model chunks,
  completion/audio-ready events, and truncation metadata are deliberately not
  broadcast: recipient tags are not known until a reply is finalized.
- GET /polling/messages?chatId=&lastMessageId=, GET /polling/chats?timestamp=

Tools:
- GET /tools?chatId= — catalog. With a chat ID, this is membership-gated
  before the chat's loaded state is returned.
- PATCH /chats/:id/tool-config — push machine overlay {tools, promptOverrides,
  loadedTools}; frontend doc overrides validated to frontend groups only
- POST /chats/:id/tool-response — answer approval/execution requests

Other:
- GET /models — model list for pickers
- GET /ai-cards (+POST/PATCH/DELETE) — reusable AI personas (owner-scoped)
- PUT /files/chats/:chatId/<path> — sandboxed file upload; downloads via GET
- CORS: reflected only for origins listed in IRIS_TRUSTED_ORIGINS,
  credentials enabled.

## Authorization policy

`resolveViewer` only resolves an identity: an absent session becomes the shared
guest identity. It is never an authorization check. Routes must use the
following policy categories explicitly.

| Policy | Routes |
| --- | --- |
| Public/bootstrap status | `GET /admin/bootstrap/status`, BetterAuth endpoints |
| Guest only | `GET /chats/guest` |
| Authenticated account | creating chats; AI-card CRUD |
| Chat member | every `/chats/:chatId/*` operation, polling messages, transient/cached audio, attachment upload/download, and `GET /tools?chatId=` |
| Administrator | every other `/admin/*` control-plane route |

The former generic provider (`/providers/:name/:functionality`), plugin
passthrough (`/plugin/*`), and backend audio-device stream (`/stream/audio/*`)
routes are deliberately not mounted. Provider access is internal to the typed
chat/tool and administration flows until a separately designed, validated,
capability-bound API exists.
