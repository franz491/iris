Search one topic with a case-insensitive regular expression. Prefer `docs_search` for plain text.

Example:

```json
{ "topic": "typescript", "regex": "interface\\s+[A-Z]\\w+", "subpath": "handbook" }
```

Results and `allow_large_output` work like `docs_search`. Keep patterns simple; regex execution has a timeout guard.
