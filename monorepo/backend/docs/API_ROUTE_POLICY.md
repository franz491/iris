# API authorization policy

This matrix is the default-deny policy for backend HTTP routes. Authentication
only establishes an identity; it does not grant chat or administrator access.

| Route family | Anonymous/guest | Registered non-member | Chat member | Administrator |
| --- | --- | --- | --- | --- |
| `POST /chats` and AI-card CRUD | Deny | Own cards; create chats | Own cards | Own cards |
| `/chats/:chatId/*`, polling messages, stream, attachments, audio handles/cache | Guest chat only | Deny | Allow | Allow when a member |
| `/polling/chats`, model discovery, setup info | Guest-safe view where applicable | Allow | Allow | Allow |
| `/chats/guest` | Allow | Deny | N/A | Deny |
| `/api/admin/bootstrap/*` | Only unconfigured bootstrap flow | Deny after configuration | Deny | Bootstrap status only |
| All other `/api/admin/*` | Deny | Deny | Deny | Allow |

Policy helpers are intentionally explicit:

- `resolveViewer` resolves a registered session or the shared guest identity.
- `requireAuthenticatedUser` rejects guests.
- `requireChatMember` resolves a viewer and checks the specified chat.
- `requireAdmin` requires an authenticated account with the current admin role.

The generic provider and plugin passthrough routes have been removed. New API
routes must select one of these policies before implementation; client-side
checks are never an authorization boundary.

Administrative account operations require a non-PIN password of at least 12
characters. The final administrator cannot be demoted or deleted. Bootstrap
tokens are reserved until account creation and promotion both succeed, then
released if either operation fails; failure responses never include internal
exception text.

Binary boundaries are deliberately small: attachments and transient audio
handles are capped at 10 MiB. Attachment responses are checked after base64
decoding; audio handles require `audio/wav` (or `audio/x-wav`) and a RIFF/WAVE
header. Oversize bodies return 413 and malformed audio returns 400.

The main and admin API routers reject JSON requests whose declared body is over
1 MiB with the same 413 response before any route handler parses them.

Known follow-up: admin mutation routes still need recent-auth/MFA policy and
their request-validation/abuse limits (IRIS-012 and IRIS-013).

The route-policy integration suite in `tests/api-integration.test.ts` covers
positive and negative cases for chat history, polling, participants,
compaction, tool configuration/catalog access, shared discovery routes, and
representative administrator reads across guest, registered non-member, chat
member, and administrator identities. The broad admin-denial table in the
same suite covers the remaining non-bootstrap admin declarations.
