Search case-insensitively inside one topic. Optionally restrict the search with `subpath`.

Example:

```json
{ "topic": "react", "query": "cleanup function", "subpath": "reference" }
```

Results are `file:line: excerpt`. If capped, retry with `allow_large_output:"head"` or `"tail"`; use `"all"` only when necessary.
