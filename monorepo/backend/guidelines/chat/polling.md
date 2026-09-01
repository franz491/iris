polling.ts - polling functionality

EXPORTS

getMessagesSinceId(chat: ChatId, participantId: ParticipantId, lastMessage: MessageId): Promise<Message[]>

gets them from SQLite, max 500 messages.


getChatsSinceTimestamp(participantId: ParticipantId, timestamp): Promise<Chat[]>

gets them from SQLite, max 1000 chats.

## ASSUMPTIONS
- getMessagesSinceId delegates to the chat DB layer; getChatsSinceTimestamp interprets "since" as chats created after the timestamp (message-level activity tracking deferred). Caps 500/1000 respected.
- participantId param of getChatsSinceTimestamp currently unused (see QUESTIONS.md).

## ANSWERS
- getChatsSinceTimestamp: user-scoped; returns chats created after the timestamp OR where the user's participant was added after it (needs added_at on chat membership). "All chats since yesterday" semantics, including old chats newly joined.
- Message reads are filtered per viewer (canReadMessage): AI->AI whispers are visible to all humans; whispers involving a human are sender/recipients only. FE renders whisper labels as "whisper to xxx".

## IMPLEMENTED
- getChatsSinceTimestamp(userId, ts): user-scoped; returns chats created after ts OR joined after ts (participants.added_at). Cap 1000.
