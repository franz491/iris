# Reconciliation process-phase harness

Run each phase as a separate `pnpm` process against one temporary root:

```sh
ROOT=$(mktemp -d /tmp/iris-reconciliation-phase.XXXXXX)
IRIS_PHASE_ROOT="$ROOT" pnpm reconciliation:phase seed
IRIS_PHASE_ROOT="$ROOT" pnpm reconciliation:phase recover
IRIS_PHASE_ROOT="$ROOT" pnpm reconciliation:phase verify
IRIS_PHASE_ROOT="$ROOT" pnpm reconciliation:phase recover-again
IRIS_PHASE_ROOT="$ROOT" pnpm reconciliation:phase verify
IRIS_PHASE_ROOT="$ROOT" pnpm reconciliation:phase seed-failure
IRIS_PHASE_ROOT="$ROOT" pnpm reconciliation:phase seed
IRIS_PHASE_ROOT="$ROOT" pnpm reconciliation:phase fail-recover || test $? -ne 0
IRIS_PHASE_ROOT="$ROOT" pnpm reconciliation:phase verify-failure
rm -rf -- "$ROOT"
```

The harness uses a real SQLite journal schema and the injectable recovery core;
`recover-again` proves idempotence, while the failure phase leaves
`recovery_failed` and exits before continuation. These are independent-process
invocations, but not a real server termination/restart drill, so they do not by
themselves close IRIS-035's process-boundary evidence gap.
