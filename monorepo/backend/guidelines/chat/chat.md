chat.ts - chat functionality

getChat(ChatId, chatSettings): Promise<Chat>


createChat(participants, chatSettings): Promise<Chat>


the actual chat implementation will contain:

sendMessage(message: Message, chat: Chat, silent = false): Promise<void>

add the specified message to the db. Then get all participants minus sender in the chat, filtered by role (only ai). If any participants are returned, call pingAiParticipant for each of them. if silent is true, it will skip the last part and only add to the db.


editHistory(oldMessage: MessageId, newMessage: Message): Promise<void>

change a previous message to a new version.


getParticipants(): Promise<ChatParticipant<"ai"|"user"[]>

retrieves all participants


subscribe(function): function

subscribe to streams, receiving each packet as argument to your function. Returns an unsubscribe function.


getMessagesSinceId(participantId: ParticipantId, lastMessage: MessageId): Promise<Message[]>

what the name says


pingAiParticipant(participant: ChatParticipant<"ai">): Promise<void>

Sends a completion request to the AI. It retrieves all messages readable by that AI since its last compaction (canReadMessage), appends system prompts (roster, loaded-tool docs, willReply, conditional groupChat, and optional noReply), then runs ONE streaming completion with tools. Final text goes through routeReply() (<no-reply> / @tag whispers / paragraph splitting) and each routed message is sent via sendMessage silently. It tracks which AIs are replying; a new message while prompting consults interruptAiParticipant — if allowed, generation aborts, "- *<interrupted>*" is appended, persisted silently, and generation restarts.


willReply(ctx: ChatContext, participant: ChatParticipant<"ai">): Promise<WillReply>

streams the final context through the model router, emitting {kind: "stream"} chunk packets to subscribers; streamed tool-call deltas are accumulated and executed between iterations (max 8); reply segments are split at reasoning boundaries (collectStreamSegmented) and routed via sendRouted.


interruptAiParticipant(sender: ChatParticipant<"ai"|"user">, talking: ChatParticipant<"ai">): boolean

Based on chat settings, it will either return true or false. settings.userInterruptions will allow interrupting iff sender is user; settings.aiInterruptions will allow interrupting always.

## ASSUMPTIONS
- willReply PREFLIGHT REMOVED: no tool call. The editable `willReply` system
  prompt defines paragraph/@tag routing; the separate editable `noReply`
  prompt teaches `<no-reply>` silence only when forceAiReply is disabled.
- Interrupt flow: while an AI is replying, new messages trigger interruptAiParticipant(sender); if allowed, the running generation is aborted, "- *<interrupted>*" appended, persisted silently, then generation restarts with fresh context. stopAiParticipant (stop button) aborts the same way (truncated reply saved with the suffix) but registers NO pending interrupt, so generation does NOT restart; it ignores chat settings.
- Streamed packets go to chat subscribers as {kind: "stream"|...} envelopes; the finalized reply is stored silently (no re-ping).
- ChatSettings {userInterruptions, aiInterruptions} kept in-memory per ChatInstance (not yet persisted).

## ANSWERS
- Interrupt policy confirmed: immediate restart after saving the truncated message (enables AI-to-AI conversations).
- willReply preflight removed entirely; the reply protocol lives in the willReply prompt (see ASSUMPTIONS above).

## ANSWERS / IMPLEMENTED
- ChatSettings are persisted in the chat DB (`chat_settings` table), loaded on getChat and saved on setSettings/createChat.
- Auto-compaction runs after each successful reply when estimated usage (chars/4 tokens vs maxContext) >= the participant's compactionThreshold percentage (default 80).
