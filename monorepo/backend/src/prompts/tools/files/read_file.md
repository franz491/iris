Read a file using a path relative to the sandbox root. Set `show_line_numbers` to `true` before a line-based edit.

Example:

```json
{ "filename": "src/app.ts", "show_line_numbers": true }
```

Set `encoding` to `base64` for binary files such as images or audio; otherwise use `utf8`. Line numbers apply only to UTF-8 text.
