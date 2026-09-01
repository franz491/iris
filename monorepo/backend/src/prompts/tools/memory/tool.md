Long-term memory beyond the visible chat history. Choose exactly one type:

- `agent`: facts about you, the AI (identity, capabilities, past work).
- `behavior`: instructions for how you should interact or respond.
- `self`: facts about the human user, such as preferences or background.
- `routine`: repeatable procedures, schedules, or recurring tasks.

Each memory has one fact and one or more short retrieval keywords. Recall uses ANY matching keyword, so call `list_keywords` before adding a memory and reuse relevant terms. Store only information worth using in a later conversation; do not save temporary chat details or duplicate an existing memory.

Public memories can appear in other chats. Private memories are visible only when their owner is the chat's sole human, and can only be stored for that human.
