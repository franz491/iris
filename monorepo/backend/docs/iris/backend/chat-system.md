# Iris backend — chat system

Core code: `src/chat/` (chat.ts ChatInstance, database.ts persistence,
ai-participants.ts context building, tools.ts tool system).

## Chats & participants

- Chats have participants: humans (role "user", tied to an auth user) and AIs
  (model name + optional system prompt + optional apiKeyName).
- Per-chat persisted settings (chat_settings table): userInterruptions,
  aiInterruptions, forceAiReply, loadedTools (JSON array of tool group names).
- Messages are ordered by per-chat `seq` (timestamps can tie). Message types:
  text, file, tool (assistant call), tool_result, compaction markers.
- Whisper readability (canReadMessage in ai-participants.ts): broadcasts are
  public; sender + recipients always read their whispers; AI->AI whispers are
  also readable by ALL humans but by NO other AI; whispers involving a human
  are sender/recipients only. Enforced in AI context building, the history +
  polling routes, and FE-side for live SSE (app.canRead).
- Every authored turn is prefixed with "name: " in AI context (humans AND
  AIs) so any participant can be @tagged.
- Edits supersede (keep seq position); DELETE truncates the message and all
  following ones (SSE kind=truncated).

## Reply protocol (replaces the old willReply preflight)

When an AI is pinged, the full context is assembled and ONE completion runs:

1. System messages: participant prompt, loaded-tool docs, and base output
   prompt (`importantInfo`). Chats with more than two participants also receive
   `groupChat` for @tag routing and thought privacy. When
   `forceAiReply=false`, `noReply` is appended:
   - output exactly `<no-reply>` to stay silent (detection also tolerates
   `no reply` and `no-reply`)
   - include exact @username tags anywhere in a paragraph to whisper to those
     users while keeping the tags visible
   - use the explicit `<new-message>` token to create separate messages; blank
     lines do not create new messages
   - a reply is either plain user-facing text, or one or more tool calls and
     nothing else. Never mix.
2. If tools are active, a non-streaming loop (max 8 iterations) executes
   tool calls and continues generation; otherwise tokens stream directly.
3. Final text goes through routeReply(): optional <no-reply> suppression,
   @tag recipient resolution, and `<new-message>` splitting. Tags remain visible;
   unresolvable tags remain literal text.
4. After a successful reply, auto-compaction runs when the AI's context usage
   is >= its threshold (default 80%): older messages are folded into
   compactedContext; SSE events compacting/compacted notify clients.

Interrupts (user/AI, per chat settings) abort the current stream, save the
partial message suffixed "- *<interrupted>*", and immediately restart.
The stop button (POST /api/chats/:id/stop, body {participantId?}) saves the
same truncated reply but does NOT restart; it ignores the interruption settings.

## Live updates

SSE stream per chat at GET /api/chats/:id/stream with kinds: message, edit,
willReply (legacy, no longer emitted), stream, done, deleted, tool_request,
truncated, compacting, compacted. Polling fallbacks exist under /api/polling.
