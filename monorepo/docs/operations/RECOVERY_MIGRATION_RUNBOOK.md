# Offline recovery and migration runbook

Stop the service and confirm all database handles are closed. Inspect status:

```sh
IRIS_RECOVERY_CONFIRM=CLOSED_HANDLES iris migration status
```

Create a canonical backup pair (manifest is owner-only `0600`):

```sh
IRIS_RECOVERY_CONFIRM=CLOSED_HANDLES iris recovery backup TEMP_ROOT SOURCE BACKUP MANIFEST
IRIS_RECOVERY_CONFIRM=CLOSED_HANDLES iris migration dry-run
```

Abort on `newer` or `corrupt` status. Perform migration only after status is
`current`/`old` and the verified pair is retained. Re-run status and SQLite
integrity verification afterward. On failure, do not overwrite the target;
restore into a staged destination using the same closed-handle confirmation:

```sh
IRIS_RECOVERY_CONFIRM=CLOSED_HANDLES iris recovery restore TEMP_ROOT BACKUP DESTINATION MANIFEST
```

Backup/manifest writes are no-overwrite and clean newly-created artifacts on
failure. Run the non-destructive drill with
`pnpm --filter @iris/backend recovery:drill:test`.
The offline retention drill (including dry-run, exact removal, minimum-keep,
and tamper fail-closed checks) is run with
`pnpm --filter @iris/backend recovery:retention:drill:test`.

The optional scheduler is disabled unless `IRIS_RECOVERY_RETENTION_ENABLED=true`.
When enabled, set `IRIS_RECOVERY_RETENTION_INTERVAL_MS` (default 24 hours),
`IRIS_RECOVERY_RETENTION_MINIMUM_KEEP` (default 1), and optionally
`IRIS_RECOVERY_TEMP_ROOT`. Scheduled runs remain dry-run unless
`IRIS_RECOVERY_RETENTION_APPLY=true` and
`IRIS_RECOVERY_CONFIRM=RETENTION_DELETE` are both set. The scheduler starts
only after backend readiness and is cancelled during coordinated shutdown; it
does not overlap runs.

## Retention (operator-confirmed)

Retention is an explicit offline operation; it is not scheduled and never
scans outside the supplied roots. First produce a deterministic dry-run plan
(the default) and inspect the listed `keep` and `remove` paths:

```sh
IRIS_DATA_DIR=DATA_ROOT iris recovery retention TEMP_ROOT [MINIMUM_KEEP]
```

`MINIMUM_KEEP` defaults to `1` and must be a positive integer. Pairs are
revalidated, ordered newest-first by their manifest timestamp (with a stable
path tie-break), and duplicate wrappers for one backup are counted once. Only
valid pairs newer than the minimum are candidates for removal.

To apply an inspected plan, repeat the command with the deliberate apply mode
and confirmation (use the same roots and minimum):

```sh
IRIS_DATA_DIR=DATA_ROOT IRIS_RECOVERY_CONFIRM=RETENTION_DELETE \
  iris recovery retention TEMP_ROOT [MINIMUM_KEEP] apply
```

Apply revalidates every planned pair before deleting anything and removes only
the exact manifest and backup paths from that plan. Any root-confinement,
symlink, manifest, digest, or concurrent-tamper failure aborts without
deletion. Verify the command's JSON output, confirm all retained manifests and
backups still exist, and rerun the dry-run to confirm no unexpected removals
remain.

## Recovery procedures

### API-key master-key rotation

Keep the service stopped and retain a verified backup pair before rotating. The
key files must be private regular files owned by the service account and contain
canonical base64 for exactly 32 decoded bytes. Use distinct files:

```sh
IRIS_DATA_DIR=DATA_ROOT iris key rotate \
  --current-key-file CURRENT_KEY_FILE --new-key-file NEW_KEY_FILE
```

The command acquires the data-root maintenance lock, creates a verified
`keys.db` backup, authenticates and decrypts every existing key, rewrites them
in one transaction, and verifies each ciphertext before returning success. It
does not print or audit key material. Replace the configured master-key file
only after success, restart, and verify named keys resolve. Reload failure is
rolled back to the old key; other failures preserve the prior key material and
configuration. A concurrent rotation is rejected by the lock.

### Migration, corrupt database, lost administrator, and stuck lock

With all handles closed, inspect every owned ledger before migration:

```sh
IRIS_RECOVERY_CONFIRM=CLOSED_HANDLES iris migration status
IRIS_RECOVERY_CONFIRM=CLOSED_HANDLES iris migration dry-run
```

`newer` and `corrupt` are stop conditions. Restore a verified pair into a new
staged data root, run integrity/status checks there, then promote only through
the atomic restore path. Do not edit SQLite files or migration ledgers by hand.
If the administrator account is unavailable, use the local bootstrap/re-auth
flow against the stopped owner-controlled root; do not modify authorization rows
manually. A lock that remains after graceful shutdown is a stuck-lock incident:
preserve the root and logs, confirm process ownership, and retry only after the
owning process exits.

### Disk-full and broken managed service

On `ENOSPC`, stop writes, preserve the data root, and free space outside it or
expand the volume. Re-run integrity and migration status before retrying. Never
delete arbitrary backups, logs, or databases. Managed-service failures are
retried only through the configured ownership policy; shutdown targets owned
processes only and never uses broad name/pid matching. Connect-only or foreign
services are reported unavailable and are not stopped by Iris.

### Cache purge and logs/support bundle

Cache cleanup is an operator action, not an automatic recovery step. Disable the
cache through the authenticated admin configuration flow, verify the new
configuration, and restart before removing any explicitly identified cache

Offline cache purge is dry-run by default and opens its own short-lived SQLite
connection (it never imports the audio-cache singleton):

```
IRIS_CACHE_CONFIRM=CACHE_PURGE iris cache purge apply
```

Run `iris cache purge` first to inspect the exact row/artifact plan. Apply is
accepted only when canonical admin configuration has `cache.enabled=false`; it
revalidates that setting and every target immediately before mutation, rejects
symlinks or paths outside the canonical data root, deletes only the
`admin_tts_playback` rows and direct files in `tts-cache`, and never performs
recursive or glob deletion. A lock/open database causes the operation to fail
closed.
database. Do not use recursive/glob deletion in the data root. Request the
administrator-only support bundle outside the data root:

```sh
curl --fail --cookie ADMIN_COOKIE \
  http://127.0.0.1:PORT/api/admin/support-bundle > iris-support-bundle.json
```

The bundle is bounded and redacted; inspect readiness, migration, metrics, and
audit fields without adding secrets or local paths. Preserve active logs and
their `.1` sibling during incidents; remove only explicitly named files after
retention approval.

### Rollback and verification checklist

Use the authenticated admin rollback flow only after confirming the patch is
current. Verify version, setup/provider projections, audit entry, and journal.
If reconciliation fails, leave the patch applied and preserve the journal for
startup recovery; do not edit the database directly. Repeat after recovery and
confirm the second recovery is idempotent. Record exact roots, command output,
readiness, and retained manifests as incident evidence.
