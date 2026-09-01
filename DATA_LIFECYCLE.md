# Iris local-state inventory

This document records the 2026-08-28 repository snapshot and the intended
location and retention of every non-source tree. It deliberately does not
preserve the snapshot: the project is pre-production and the user has declared
all database contents disposable. It is useful as a boundary for future work
and for a clean clone once version control is introduced.

## Current layout and ownership

| Current path                                                                                                                    | Classification and owner                                                                                                       | Observed snapshot                                                                                            | Retention / backup rule                                                                                                                                                                                                     | Target location                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monorepo/backend/src`, `monorepo/frontend/src`, `monorepo/frontend/src-tauri/src`, `tests`, `guidelines`, manifests, lockfiles | First-party source and developer documentation; owned by Iris maintainers                                                      | Source tree                                                                                                  | Retain; version-control when the repository is initialized                                                                                                                                                                  | Repository                                                                                                                                                                                               |
| `monorepo/backend/data`                                                                                                         | Backend machine-local state; owned by the backend through `IRIS_DATA_DIR`                                                      | 21 GB, 142,866 files; SQLite state, setup/configuration, locks, cache, and managed software                  | Disposable now. Do not version-control. Future real user data needs an explicit backup policy before migration.                                                                                                             | `IRIS_DATA_DIR`; set it outside the repository. Current default: `$XDG_DATA_HOME/iris` (or `~/.local/share/iris`) on Linux, `~/Library/Application Support/Iris` on macOS, `%APPDATA%\\Iris` on Windows. |
| `monorepo/backend/data/*.db`, `*.db-wal`, `*.db-shm`                                                                            | SQLite database sets; backend modules own the individual schemas                                                               | `admin`, `auth`, `chat`, `config`, `keys`, `memory`, and `prompts` databases, with active WAL/SHM companions | Disposable now. A future backup must use SQLite online backup (or stop writers) and include the coherent WAL state; never copy a live main DB alone.                                                                        | Under `IRIS_DATA_DIR`                                                                                                                                                                                    |
| `monorepo/backend/data/setup.json`, `config.yaml`, `prompts/`                                                                   | Bootstrap settings and machine-local prompt overrides; setup/prompt modules own them                                           | `setup.json` exists; `config.yaml` and `prompts/` are supported locations                                    | Disposable now. Future export must redact/secure credentials and include only deliberate overrides.                                                                                                                         | Under `IRIS_DATA_DIR`                                                                                                                                                                                    |
| `monorepo/backend/data/tts-cache`, `locks`, `audio-cpp`                                                                         | Regenerable playback cache, service locks, and service config; admin/audio modules own them                                    | 2.3 MB cache plus small lock/config trees                                                                    | Never back up the cache or locks. Preserve only an intentional service configuration export when it becomes user data.                                                                                                      | Under `IRIS_DATA_DIR`                                                                                                                                                                                    |
| `monorepo/backend/data/software`                                                                                                | Downloaded/managed third-party runtimes; admin software installer owns it                                                      | 21 GB before IRIS-021 cleanup; includes `.venv`, ComfyUI, GPT-SoVITS variants, Qwen TTS, and sherpa-onnx     | Regenerable; removed in IRIS-021 under the project's throwaway-data policy. Do not version-control or back up binaries/models. Keep a future declarative install manifest with versions, source URLs, and licenses instead. | `IRIS_DATA_DIR/software`                                                                                                                                                                                 |
| `monorepo/backend/files`                                                                                                        | Files-provider sandbox/default local assets; files provider owns the configured root                                           | 99 MB, 55 files; voices and GPT-SoVITS datasets/output                                                       | Disposable test/development material in this snapshot. Do not version-control large assets. A future user-selected files root must be backed up by its owner, independently of Iris database state.                         | A user-selected files-provider root outside the repository; do not place user files below the source tree.                                                                                               |
| `monorepo/backend/node_modules`, `monorepo/frontend/node_modules`, `monorepo/node_modules`                                      | Package-manager dependencies; pnpm owns them                                                                                   | 120 MB backend, 2.3 MB frontend, 128 MB workspace                                                            | Regenerable from the lockfile; never back up or version-control.                                                                                                                                                            | Package-manager store/workspace installation                                                                                                                                                             |
| `monorepo/backend/dist`, `monorepo/frontend/dist`                                                                               | Compiled JavaScript/web assets; build tooling owns them                                                                        | 1.2 MB backend, 352 KB frontend                                                                              | Regenerable; never back up or version-control.                                                                                                                                                                              | Build output directory or release artifact store                                                                                                                                                         |
| `monorepo/frontend/src-tauri/target`                                                                                            | Rust/Tauri compiler output; Cargo owns it                                                                                      | 3.8 GB                                                                                                       | Regenerable; never back up or version-control.                                                                                                                                                                              | Cargo target directory or CI cache                                                                                                                                                                       |
| `:memory:.ses`                                                                                                                  | Local tool/session artifact; development environment owns it                                                                   | Root-level session file                                                                                      | Disposable; never version-control.                                                                                                                                                                                          | Tool-managed temporary/session location                                                                                                                                                                  |
| `monorepo/external/audio-cpp-service`                                                                                           | First-party integration documentation; Iris maintainers own the contract, while upstream owns `audiocpp_server` and its models | README only                                                                                                  | Retain the pointer; do not treat it as vendored source, a submodule, or a package cache.                                                                                                                                    | Repository documentation; separately installed runtime/models remain outside the repository                                                                                                              |

All listed mutable paths were mode `0775` in the snapshot. Future application
state should instead be created with a restrictive owner-only policy, especially
the `keys.db` database and any exported configuration.

## Current runtime contract

The backend already supports an external state directory:

```sh
IRIS_DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/iris" pnpm --dir monorepo/backend dev
```

`monorepo/backend/src/db/sqlite.ts` resolves `IRIS_DATA_DIR`; without it, state
uses the platform application-data default recorded above. The files provider separately defaults to a
relative `files/` root, so it must be configured with a user-owned location
outside the repository before this tree is removed. This is a documentation of
the current contract, not a migration: application-path changes remain a later
ticket.

## Disposal and future recovery

No backup or restore drill is appropriate for the current throwaway snapshot.
To reset local state today, stop the backend and use the existing `iris wipe`
command (which deletes database/configuration state), or remove a _specific_
external `IRIS_DATA_DIR` after verifying it is an Iris state directory. Do not
delete an unverified path and do not delete a selected files-provider root as
part of a database reset.

Before accepting non-disposable data, implement and test this recovery process:

1. Quiesce writers or use SQLite's online backup API for every database.
2. Produce a versioned manifest recording application/schema versions and
   checksums; treat `keys.db` and secrets as encrypted sensitive material.
3. Exclude `tts-cache`, locks, compiler output, dependencies, and downloaded
   runtimes; retain declarative metadata necessary to reinstall them.
4. Restore into a newly created empty `IRIS_DATA_DIR`, then run read-only checks
   for auth, chats, prompts, configuration, and attachments.

Because this repository is not currently a Git worktree, tracked/untracked or
ignored status and commit-history secret scanning cannot be established. The
root `.gitignore` is therefore a policy ready for repository initialization,
not evidence that existing paths are tracked or ignored.

## IRIS-021 cleanup record (2026-08-28)

The following verified regenerable or machine-local paths were removed without
backup under the explicit throwaway-data instruction. The sizes are the
pre-removal `du -sh` observations; they are recorded so the cleanup is
auditable, rather than treated as a source-tree change.

| Removed path                         | Pre-removal size | Reason                                                                 |
| ------------------------------------ | ---------------: | ---------------------------------------------------------------------- |
| `monorepo/backend/data`              |            21 GB | Machine-local databases, cache, locks, and downloaded managed runtimes |
| `monorepo/backend/node_modules`      |           120 MB | Reproducible pnpm installation                                         |
| `monorepo/frontend/node_modules`     |           2.3 MB | Reproducible pnpm installation                                         |
| `monorepo/node_modules`              |           128 MB | Reproducible pnpm installation                                         |
| `monorepo/backend/dist`              |           1.2 MB | TypeScript build output                                                |
| `monorepo/frontend/dist`             |           352 KB | Frontend build output                                                  |
| `monorepo/frontend/src-tauri/target` |           3.8 GB | Cargo/Tauri build output                                               |
| `monorepo/backend/files`             |            99 MB | Explicitly confirmed disposable media/dataset tree                     |
| `:memory:.ses`                       | Session artifact | Local tool state                                                       |

`monorepo/backend/files` was removed after explicit confirmation that the files
folder and settings are disposable. Future user-selected files roots remain
outside the repository and require their own backup policy.

During concurrent verification after this cleanup, package-manager and Cargo
commands recreated ignored `node_modules` directories and the Rust `target`
directory. That confirms the intended lifecycle: they are regenerated output,
not restored source or data. They were intentionally not removed a second time
while active verification work was using them.

The cleanup preserved all source directories, package manifests, and the
workspace pnpm lockfile,
and `monorepo/external/audio-cpp-service/README.md`. A clean rebuild requires
reinstalling dependencies from the workspace pnpm lockfile, then running the
documented package build/test commands; those commands recreate only paths
covered by `.gitignore`.

## API-key encryption

Named provider API-key values are encrypted in `keys.db` with AES-256-GCM.
The master key is never stored in SQLite, logs, source, backups, or support
bundles. Generate one with `openssl rand -base64 32`.

Provide it at startup as `IRIS_API_KEYS_MASTER_KEY`, or put the base64 value in
a dedicated file referenced by `IRIS_API_KEYS_MASTER_KEY_FILE`. The file must
be outside the repository, readable only by the Iris service account (`0600`),
and must contain exactly 32 decoded bytes. Do not pass it on command lines.

On first startup against a legacy plaintext `keys.db`, the service performs a
transactional migration when the master key is available. Keep a permissions-
restricted backup until verification succeeds. If the key is missing or
incorrect, encrypted values fail closed and names remain listable; do not
delete or recreate the database. Rotation is supported through the non-HTTP
CLI. First stop writers and make a SQLite online backup including coherent WAL
state; retain the old key and backup. Prepare a separate owner-only file with
a new base64-encoded 32-byte key, then run
`iris key rotate --current-key-file OLD --new-key-file NEW`. The command
authenticates every row before mutation, re-encrypts with fresh nonces in one
transaction, verifies every row under the new key, and rolls back on failure
without printing secrets. Only after success replace the configured startup
key file, preserve the old file and backup until restart and read-only
verification succeed, then retire them per storage policy. The running process
retains its originally configured key and must restart (or explicitly reload
configuration) before using the new key. SQLite WAL pages, backups, snapshots,
and flash wear may retain old ciphertext; secure erase remains operational.
OS keyring integration remains the preferred desktop follow-up.

## IRIS-062 bounded SQLite recovery

`src/db/recovery.ts` provides an offline-only backup/restore primitive. Callers
must supply data and temporary roots; source, destination, and backup paths are
confined to those roots. Backups include coherent WAL state via SQLite's online
backup API, are integrity-checked and SHA-256 manifested, and are promoted with
no-overwrite atomic linking and owner-only permissions. Restore additionally
requires explicit confirmation that all database handles are closed and rejects
hash, size, or integrity mismatches while preserving the existing target.
Full backup orchestration (retention, scheduling, key-rotation integration,
remote/export handling, and operator UX) remains outstanding.

The bounded local operator command is `IRIS_RECOVERY_CONFIRM=CLOSED_HANDLES
iris recovery backup TEMP_ROOT SOURCE DESTINATION`; it prints manifest JSON.
Restore uses `iris recovery restore TEMP_ROOT BACKUP DESTINATION MANIFEST` and
requires the same confirmation, which is the operator's assertion that service
and database handles are closed. It remains intentionally non-HTTP and local.
Recovery drill command: `pnpm --filter @iris/backend recovery:drill:test`. It
uses isolated temporary WAL-backed databases, exercises backup/manifest/
integrity/restore verification, and cleans only its own temporary resources.
Offline migration workflow: run `IRIS_RECOVERY_CONFIRM=CLOSED_HANDLES iris
migration status` (or `dry-run`), create a verified recovery pair, perform the
planned migration while handles are closed, rerun status/integrity checks, and
use the documented recovery restore command if verification fails. Status is
read-only and local; it does not perform migrations or scheduling.
