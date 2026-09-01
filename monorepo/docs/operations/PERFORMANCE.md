# Performance checks

The first repeatable performance contract covers the large-history participant
lookup hotspot. It uses a disposable 5,000-participant fixture, three warmups,
and ten measured iterations with 1,000 deterministic lookups per iteration.
The regression budget is operation-based rather than machine-time-based: each
iteration must build one participant index and perform exactly the fixed lookup
count. This avoids false failures from shared CI load while detecting a return
to per-message participant scans.

Run it with:

```sh
pnpm --filter @iris/frontend performance:check
```

The fixture contains no runtime data, network calls, or production writes. The
test also verifies deterministic lookup correctness and emits a stable summary
of fixture and operation counts.

The backend prompt-construction contract uses the same disposable-data policy
with 5,000 seeded messages and two AI participants. It verifies that each
context contains the complete deterministic history and that role visibility
is preserved while the shared role lookup is built once per context build.
Run it with:

```sh
pnpm --filter @iris/backend performance:check
```

The backend history contract also uses 5,000 seeded messages and a fixed page
size of 100. It requires exactly 50 bounded page queries, complete ordered
coverage, and no duplicate sequence numbers, exercising the `limit + 1`
lookahead and chronological page reconstruction without a machine-time gate.

The SSE lifecycle contract uses a fixed population of 1,000 disposable clients
and asserts one close callback per client, complete registry drain, and
idempotent repeated shutdown. It measures bounded ownership operations rather
than wall-clock fanout latency.

The tool-loop contract exercises the production parser with the maximum eight
tool calls across the maximum eight loop iterations. It asserts deterministic
filtering of active versus unknown tools and exactly 32 accepted calls, with no
provider or network work and no wall-clock threshold.

The compaction contract seeds 2,000 disposable messages and routes the summary
through an in-process fake provider. It asserts that every conversation turn
is preserved in order, system instructions are excluded from the summary
conversation, the summary input stays within a deterministic 40-byte-per-turn
fixture budget, and the persisted cursor points at the final message. It does
not make network calls or use a wall-clock threshold.

The file-transfer contract round-trips a deterministic 196,625-byte binary
fixture through the installed files provider, requiring four fixed 64 KiB data
chunks and two provider operations (write/read). It verifies byte-for-byte
correctness and that a one-byte-smaller read limit is rejected, without
network calls or a wall-clock threshold.

The admin-load contract seeds 1,200 audit rows and verifies the real audit
listing seam returns the newest bounded 1,000 entries in deterministic order
with one database operation. This protects admin and support-bundle reads from
unbounded audit-history growth without a wall-clock gate.

The startup contract seeds 64 disposable provider configurations and registers
in-process providers with no functionality or network work. It verifies each
configured provider is initialized exactly once and reaches a registered
status, with a fixed 64-initialization/zero-network operation budget and no
wall-clock gate.

The tool-document cache contract uses a fixed 256-entry budget, invalidates
older override projections for the same group, and clears owned entries during
production shutdown. It is exercised without network or wall-clock thresholds.

The built-in prompt-file cache is also explicitly owned and bounded at 256
entries. It contains only immutable bundled-file contents, uses deterministic
FIFO eviction for dynamically supplied keys, and is cleared by the production
shutdown coordinator; local DB/file overrides are resolved without entering
this cache.

`performance-baseline.json` is the published comparison artifact. Each
benchmark records baseline, current, and deterministic operation/data budgets;
the baseline contract test verifies finite nonnegative counts, exact delta
arithmetic, and that current values do not exceed their budgets. Updating a
baseline requires changing the recorded fixture and its corresponding focused
performance contract together; wall-clock values are intentionally excluded.

For optional local measurement, run `pnpm --filter @iris/backend performance:report`.
This performs warmups and repeated representative workloads and reports median
and p95 duration, throughput, heap delta, Node/platform metadata, and generous
per-workload budgets. The participant-index workload measures the same seeded
fixture with both the former linear scan and the current indexed lookup,
recording median delta and a ratio classified as either speedup or tradeoff.
The history-query workload uses the real SQLite fixture and compares a full
history load/in-memory slice with the production `getHistoryPage` LIMIT+1 path,
including ordering and duplicate checks. It also reports a first-page comparison
over the same 100-message scope, including heap deltas, which is the meaningful
benefit of pagination. The full-traversal comparison remains an honest
end-to-end workload: a ratio below 1 means a latency tradeoff, not a speedup.
The other workloads publish current-run measurements against their
generated budgets. To publish a local report, pass
`--output ../docs/operations/performance-measured-report.json`; compare a later
run with `pnpm --filter @iris/backend performance:compare`. This report is
hardware-sensitive and intentionally not part of the hard CI gate. Several
workloads are deterministic microbenchmarks of the production operation shape
rather than full database/provider/server runs; they are not empirical
before/after production evidence. The deterministic operation contracts above
remain the required CI regression gate.
