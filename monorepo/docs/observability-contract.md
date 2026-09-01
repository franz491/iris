# Observability contract

Operational events use an ISO timestamp, level, component, event name, bounded
error code, and correlation or opaque generation ID when available. Metrics use
fixed low-cardinality method/status classes and named gauges/counters only.
The DB/cache owner emits the fixed keys `db.operation` (bounded duration/count),
`db.failure`, `cache.entries`, and `cache.bytes`; cache gauges are non-negative
bounded integers and contain no database, path, or entity labels.

Logs, events, metrics, and support bundles must not contain prompts, messages,
tool arguments/results, user or chat identifiers, raw paths, environment data,
headers, cookies, tokens, passwords, API keys, or database contents. Shared
redaction is applied at logging and export boundaries; support bundles are
allowlisted deterministic JSON capped at 256 KiB. Observability failures are
contained and never change primary request or generation behavior.

Operational policy: file logs rotate at 5 MiB with one bounded sibling. The
support bundle is an explicit, on-demand admin export capped at 256 KiB; it is
not retained automatically and must be handled as sensitive operational data.
Queue depth and unsupported lifecycle domains are not represented by guessed
values; only bounded metrics with a truthful owner are exported.
