example idea. We obviously need to have an operation to add a new message, too. Perform a sanity check on the code you have here, it's not tested.
The AI participant and user participant should have all the fields described in ./types.ts (in this example they are missing many of those)

# Database schema:
PRAGMA foreign_keys = ON;

CREATE TABLE chats (
    id         TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

CREATE TABLE participants (
    id         TEXT PRIMARY KEY,
    chat_id    TEXT NOT NULL,
    type       TEXT NOT NULL CHECK (type IN ('user', 'ai')),
    created_at INTEGER NOT NULL,

    FOREIGN KEY (chat_id)
        REFERENCES chats(id)
        ON DELETE CASCADE
);

CREATE INDEX participants_chat_idx
    ON participants(chat_id);

CREATE TABLE user_participants (
    participant_id TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,

    FOREIGN KEY (participant_id)
        REFERENCES participants(id)
        ON DELETE CASCADE
);

CREATE INDEX user_participants_user_idx
    ON user_participants(user_id);

CREATE TABLE ai_participants (
    participant_id TEXT PRIMARY KEY,
    model          TEXT NOT NULL,
    system_prompt  TEXT NOT NULL,

    FOREIGN KEY (participant_id)
        REFERENCES participants(id)
        ON DELETE CASCADE
);

CREATE TABLE messages (
    id            TEXT PRIMARY KEY,
    chat_id       TEXT NOT NULL,
    author_id     TEXT NOT NULL,
    content       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    superseded_by TEXT,

    FOREIGN KEY (chat_id)
        REFERENCES chats(id)
        ON DELETE CASCADE,

    FOREIGN KEY (author_id)
        REFERENCES participants(id),

    FOREIGN KEY (superseded_by)
        REFERENCES messages(id)
);

CREATE INDEX messages_chat_created_idx
    ON messages(chat_id, created_at, id);

CREATE INDEX messages_author_created_idx
    ON messages(author_id, created_at, id);

CREATE INDEX messages_superseded_by_idx
    ON messages(superseded_by);

CREATE TABLE message_recipients (
    message_id     TEXT NOT NULL,
    participant_id TEXT NOT NULL,

    PRIMARY KEY (message_id, participant_id),

    FOREIGN KEY (message_id)
        REFERENCES messages(id)
        ON DELETE CASCADE,

    FOREIGN KEY (participant_id)
        REFERENCES participants(id)
        ON DELETE CASCADE
);

CREATE INDEX message_recipients_participant_idx
    ON message_recipients(participant_id, message_id);

## ASSUMPTIONS
- Schema completed to match types.ts: participants.name, ai_participants gained api_router/api_additional_fields/reads_others_thoughts/prompt/will_reply_prompt/last_compacted_message_id/compacted_context/max_context; messages gained type/thought columns. superseded_by retained; edit = mark superseded + insert new version.
- Implemented in drizzle ORM (src/chat/schema.ts) with raw-SQL migration; DB file <dataDir>/chat.db.
- getMessagesSinceId caps at 500 latest non-superseded messages.

## IMPLEMENTED
- participants.added_at (membership timestamp, backfilled = created_at); ai_participants.compaction_threshold (%, default 80) and api_key_name; chat_settings table. Column migrations are applied idempotently on migrateChatDb().
