Stage a complete schema-valid configuration snapshot for human review. This does not approve or apply the proposal.

Example:

```json
{
  "config": {
    "schemaVersion": 1,
    "server": {
      "host": "127.0.0.1",
      "port": 3000,
      "publicUrl": "http://localhost:3000",
      "trustedOrigins": [],
      "tls": { "mode": "localhost-only" }
    },
    "services": [],
    "profiles": [],
    "secrets": {},
    "tools": {},
    "prompts": {},
    "cache": { "enabled": false, "maxAgeSeconds": 0, "maxBytes": 0 }
  }
}
```
