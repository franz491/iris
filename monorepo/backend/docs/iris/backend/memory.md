# Iris backend — memory

Code: `src/memory/` (memory.ts facade, sql.ts storage, schema.ts).
Exposed to AIs as the always-on `memory` tool group.

- Four types: agent (facts about the AI), behavior (interaction rules),
  self (facts about users), routine (recurring tasks).
- A memory carries ONE content and MULTIPLE keywords (storage: one row per
  keyword sharing a group_id; MemoryRow.id = group id, .keywords aggregated).
  Deleting by group id removes all keyword rows.
- Visibility: public memories are visible in any chat containing them;
  private memories only resolve while their owner is the chat's single human
  user (enforced in SQL + addMemory check). The AI cannot store private
  memories on a user's behalf.
- Functionalities (kernel): list_keywords(type), list_memories(type,
  keywords[]), add_memory(type, keywords[], content, isPrivate),
  remove_memory(id). The tool loop injects chatId automatically.
- Prompt guidance tells the AI to call list_keywords before storing so it
  reuses existing keywords where appropriate.
