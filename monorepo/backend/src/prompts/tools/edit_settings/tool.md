Propose a concrete local frontend-tool configuration and ask the human to review and approve it. This never changes settings automatically.

Required arguments:

```json
{
  "tool": "files",
  "reason": "I need to inspect your Desktop project",
  "settings": { "rootFolders": ["/home/alice/Desktop/project"] }
}
```

For shell, include `workingFolder` and optionally `mode` (`host`, `docker_rw`, or `docker_readonly`). For files/docs, use `rootFolders` (one or more absolute folders). The user can edit every proposed value before approving. With several humans, set `target_user`.
