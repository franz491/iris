Replace every match of a JavaScript-style regex in one file. The regex uses global and multiline flags; `substitution` supports `$1`, `$2`, and so on.

Example:

```json
{ "filename": "app.ts", "pattern": "const (PORT) = \\d+;", "substitution": "const $1 = 3001;" }
```

Because every match changes, use `edit_file` for one exact replacement. Read the file first and make the pattern as narrow as possible.
