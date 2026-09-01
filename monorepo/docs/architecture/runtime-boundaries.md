# Runtime boundaries

## Request identity

Unauthenticated requests resolve to the shared user ID `guest`; an authenticated session resolves to its account ID. Identity resolution is separate from authentication enforcement: routes that must exclude guests call `requireAuthenticatedUser`, while chat operations call `requireChatMember`. See [`backend/src/api/api.ts`](../../backend/src/api/api.ts#L170-L201).

## Guest access

Guest access is intentionally narrow. A guest may access a chat only when it has no registered users. Guests do not appear in normal membership listings; their supported entry point is `GET /api/chats/guest`, which returns the universal guest chat. See [`backend/src/chat/auth.ts`](../../backend/src/chat/auth.ts#L8-L28), [`backend/src/chat/database.ts`](../../backend/src/chat/database.ts#L658-L669), and [`backend/src/api/api.ts`](../../backend/src/api/api.ts#L735-L748).

The frontend reflects this boundary by loading the guest chat instead of creating a chat for a guest session. See [`frontend/src/lib/state.svelte.ts`](../../frontend/src/lib/state.svelte.ts#L100-L118).

## Message delivery

Whisper authorization is evaluated on the server. History responses pass through `filterReadable`, and SSE message/branch events use the same role-aware `canReadMessage` predicate. Raw model stream chunks are not emitted before final routing, so a private mention cannot leak through an intermediate token. See [`backend/src/api/api.ts`](../../backend/src/api/api.ts#L114-L165) and [`backend/src/chat/ai-participants.ts`](../../backend/src/chat/ai-participants.ts#L229-L255).

The tested policy is: broadcasts are readable by everyone; senders and recipients can read their whispers; AI-to-AI whispers are visible to humans but not other AIs; whispers involving a human remain limited to sender and recipients. See [`backend/tests/images-and-whisper.test.ts`](../../backend/tests/images-and-whisper.test.ts#L449-L498) and [`backend/tests/api-integration.test.ts`](../../backend/tests/api-integration.test.ts#L473-L535).
