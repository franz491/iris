# ADR-002: Server-side whisper visibility

- Status: accepted, current behavior
- Scope: history and live chat delivery

Whisper visibility is decided on the server using participant roles and recipient IDs. The same predicate governs history filtering and final SSE message events. Raw generation chunks are withheld until routing completes, preventing private content from being exposed through a live stream before recipients are known.

The policy is encoded in [`backend/src/chat/ai-participants.ts`](../../backend/src/chat/ai-participants.ts#L229-L255) and applied in [`backend/src/api/api.ts`](../../backend/src/api/api.ts#L114-L165). Regression coverage is in [`backend/tests/images-and-whisper.test.ts`](../../backend/tests/images-and-whisper.test.ts#L449-L498).
