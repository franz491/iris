Load one or more tools by exact name from the tool list in the generic `read_tool_info` description.

Example — load local file and shell access:

```json
{ "tools": ["files", "shell"] }
```

For server-side variants use names such as `backend_files`. The result reports loaded and unknown names. Do not request `memory`; it is already available.
