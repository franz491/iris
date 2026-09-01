Run one shell string and return `stdout`, `stderr`, and an exit code.

Example:

```json
{ "command": "find src -maxdepth 2 -type f | sort" }
```

The shell closes after the call. Avoid interactive commands, secret-printing commands, and unbounded output. A timeout or user approval may apply.
