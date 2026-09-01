Replace a 1-indexed, inclusive line range. First call `read_file` with `show_line_numbers:true`.

Example — replace lines 4 through 6:

```json
{ "filename": "notes.md", "replace_line_start": 4, "replace_line_end": 6, "text": "New line one\nNew line two" }
```

Use an empty `text` string to delete the range. Line numbers may become stale after another edit, so re-read when necessary.
