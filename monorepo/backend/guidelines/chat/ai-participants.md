ai-participants.ts - abstraction for AI-participants


getContextForAi(chatid, participant: ChatParticipant<"ai">): Promise<ChatContext>

gets the ai participant's lastCompacted id, takes all messages after that ID (if it hits limit of 500 it will query multiple times in a row), then it returns the context built by adding the compactedContext at the beginning of the context.


getContextForMultipleAis(chatid, participants: ChatParticipant<"ai">[])

retrieves all messages from the earliest compaction of all ais to now. Inserts the other compaction messages as messages with .to = [<ai id>] they pertain to. returns a function (id) => ChatContext which takes an AI id and returns all messages readable by that AI under canReadMessage (broadcasts; own whispers; AI->AI whispers it authored/received), starting from the compaction message directed to that id onwards and dropping any previous messages.


compactionProgress(chat: ChatId, aiParticipants?: ChatParticipant<"ai">[]): Promise<{[participantId: ParticipantId]: number}>

if aiParticipants is undefined/empty, it will retrieve all of them from the current chat. Then, it gives back a map of id->context progress


compactChat(aiParticipant): Promise<void>

gets all messages for the AI PoV after the last compaction, compacts them and updates the last-compaction status on the DB for the AI. these compaction messages are not added to the chat history.

## ASSUMPTIONS
- compactChat summarizes via the participant's own model (routeCompletionOnce) with a fixed summarizer instruction; compaction rows are NOT written into messages (kept as ai_participants.compacted_context + last_compacted_message_id pointing at the last seen message id/timestamp).
- compactionProgress heuristic: message count since compaction vs maxContext/500 budget estimate; refine once real token counting lands.
- getContextForMultipleAis injects each AI's compactedContext as a synthetic system message visible only to that AI (the .to-directed compaction-message idea).

## ANSWERS
- Compaction: explicit trigger after each AI reply, at a configurable-per-participant context budget threshold (default 80%).

## IMPLEMENTED (context compat)
- Context entries now follow the AUTHOR's role (user -> user, ai -> assistant); previously everything was assistant, which broke llama.cpp templates.
- Consecutive same-role turns are merged (mergeConsecutiveTurns): multi-AI chats legitimately produce repeated assistant messages (double sends, tool use, AI-to-AI), but some OpenAI-compatible servers reject repeated trailing roles. Merging preserves meaning/order without enforcing any structural rule.
- The openai-compat model-name case-insensitivity was reverted per user preference: exact model ids only.
