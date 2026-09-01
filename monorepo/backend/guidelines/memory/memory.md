memory.ts - accesses the 3 types of memory. Allows retrieving tags, reading memory content for tags, storing new memories, editing old memories.

Gives access to the memory database. Most of these require a "type" argument, that is one of "agent","behavior","self","routine".

All memories are kept with timestamp and information on whether they're private or public. When private, they're kept alongside a user id for the user that stored that information, so that they can only be accessed in chats where that user is the only user. all retrieval functions thus require ChatId, as the db will filter out information based on this.

- listKeywords: gets all memory keywords from a certain memory type.
- list_memories: gets a mandatory keyword list, and returns all memories of that type with the specified keyword
- add_memory: adds a new memory to one of the 4 db. Requires private/public
- remove_memory: deletes a memory.

## ASSUMPTIONS
- Spec says "3 types" but lists 4 (agent/behavior/self/routine) - implemented all 4.
- Visibility rule enforced in SQL layer: private memories retrievable iff chat has exactly one human user and they own the memory.
- add_memory(chatId,...) takes the storing userId for private entries; owner must equal the chat's single human user.
