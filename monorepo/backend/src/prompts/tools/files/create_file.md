Create or completely overwrite a file. Parent directories are created.

Example:

```json
{ "filename": "notes/todo.md", "content": "# Todo\n\n- Test the app\n" }
```

This replaces the whole file. Use `edit_file` or `edit_lines` for a partial change. Set `encoding:"base64"` when `content` is base64-encoded binary data, such as an image or audio file.
