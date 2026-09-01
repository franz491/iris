Store one durable fact. First call `list_keywords` for the chosen type and avoid duplicates. Use:

- `type`: `agent`, `behavior`, `self`, or `routine` as defined by the memory tool.
- `keywords`: one or more short, reusable retrieval terms.
- `content`: a self-contained fact that will still make sense later.
- `isPrivate`: `true` for sole-user-sensitive information; otherwise `false`.

Example — a user preference:

```json
{
  "type": "self",
  "keywords": ["preferences", "coffee"],
  "content": "The user drinks coffee black.",
  "isPrivate": false
}
```

Do not use `behavior` for facts about the user, or `self` for instructions to yourself. Private storage fails unless the owning user is the only human here.
