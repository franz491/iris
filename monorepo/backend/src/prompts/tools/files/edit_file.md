Replace one exact, unique text block. Copy `before` exactly from a recent read.

Example:

```json
{ "filename": "config.ini", "before": "port=3000\nmode=dev", "after": "port=3001\nmode=dev" }
```

The call fails if `before` is absent or occurs more than once. Re-read after a failure; include more surrounding text to make the match unique.
