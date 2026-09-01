# Iris

Iris is an early-stage local-first AI chat application. The repository contains
a TypeScript/Hono backend, a Svelte/Vite web client, and a Tauri/Rust desktop
client. It is not production-ready or a supported public-network deployment.

## Architecture

- `monorepo/backend` runs the HTTP API, authentication, chats, SQLite-backed
  configuration/memory/prompts, provider routing, and admin service control.
- `monorepo/frontend` is the Svelte web UI; Vite proxies `/api` to the backend
  during development.
- `monorepo/frontend/src-tauri` provides desktop-native file, shell, and audio
  integrations.
- `monorepo/external/audio-cpp-service` documents the separately installed
  audio.cpp integration; it is not vendored software.

## Prerequisites and clean setup

The workspace has a single `pnpm-lock.yaml` and declares Node `22.x` plus pnpm
`11.22.0` in `monorepo/package.json`. Rust, platform, and hardware support are
not pinned yet. This environment was checked with Node `22.23.2`, pnpm
`11.22.0`, and Rust/Cargo `1.98.0`; treat those as a known-working snapshot,
not a compatibility guarantee.

Install Node, pnpm, and a Rust toolchain before running the desktop checks.
Native dependency installation may require a platform C/C++ toolchain and an
initial network connection. If your Node distribution provides Corepack, enable
it before installing pnpm.

```sh
corepack enable
pnpm --dir monorepo install --frozen-lockfile
```

Run the backend and web client in separate terminals:

```sh
IRIS_DATA_DIR="$XDG_DATA_HOME/iris" pnpm --dir monorepo dev:backend
pnpm --dir monorepo dev:frontend
```

The backend defaults to `127.0.0.1:3000`; Vite defaults to `127.0.0.1:5173`.
Set `IRIS_PORT`, `IRIS_HOST`, `IRIS_BACKEND_URL`, and
`IRIS_TRUSTED_ORIGINS` deliberately if changing that local topology.

## Development and checks

From the repository root:

```sh
pnpm --dir monorepo format:check
pnpm --dir monorepo typecheck
pnpm --dir monorepo test
pnpm --dir monorepo build
pnpm --dir monorepo rust:check
pnpm --dir monorepo verify
```

`format:check` runs every workspace package's optional formatting check; the
current package set provides the Rust `cargo fmt --check` gate through the
frontend package. `verify` runs that formatting gate, lint/type checks, tests,
builds, and Rust checks.

Before creating build or test output, run the non-destructive clean-output gate:

```sh
pnpm --dir monorepo clean:check
```

It scans workspace paths for common generated directories and TypeScript build
info files, reports each matching path, and exits nonzero when any are found.
It skips dependency and VCS directories and never deletes or changes anything.
Run it before `build`, or after moving generated output out of the workspace,
when a clean source-controlled workspace is required.

The non-destructive behavior and artifact reporting are covered by a focused
automated check:

```sh
pnpm --dir monorepo clean:check:test
```

The check creates generated-output fixtures outside the repository, exercises
the scanner used by `clean:check`, verifies the reported paths, and verifies
the fixture contents are unchanged.
Backend tests place their database state in temporary directories. Most tests
stub network and hardware boundaries, but optional provider behavior may depend
on network availability; native desktop use requires the host's supported audio
devices, and Docker-backed shell modes require Docker plus an available image.

## Local data and recovery

Backend state is written to `IRIS_DATA_DIR`, or by default to the platform data
directory: `$XDG_DATA_HOME/iris` (or `~/.local/share/iris`) on Linux,
`~/Library/Application Support/Iris` on macOS, and `%APPDATA%\\Iris` on Windows.
The directory holds SQLite databases, configuration, keys, caches, and managed
runtime metadata; keep it outside this source tree. Configure the files
provider with a separately chosen user-owned root before storing attachments or
other files.

The current project snapshot is disposable. The retention policy, cleanup
record, external-runtime ownership, and future recovery prerequisites are in
[DATA_LIFECYCLE.md](DATA_LIFECYCLE.md). `pnpm --dir monorepo wipe` removes the
backend database/configuration state; it is not a backup command and must not
be used as a way to delete a user-selected files-provider root.

## Security boundary and current limitations

The backend defaults to loopback and uses configured trusted origins for
credentialed CORS. Authentication, chat membership, and server-side
recipient filtering are backend responsibilities; do not rely on the frontend
for confidentiality. Treat `IRIS_DATA_DIR`, service configuration, credentials,
and a files-provider root as sensitive local state.

The desktop client exposes native file, shell, and audio functionality, and its
current Tauri configuration uses a restrictive CSP and narrowly constrained
shell-link opening capability, but native commands remain security-sensitive.
Do not expose Iris to untrusted users, untrusted web content, or a public
network. The current architecture and security decisions are documented in
[the architecture index](monorepo/docs/architecture/README.md) and
[decision records](monorepo/docs/decisions/README.md). Supported OS versions,
CPU/GPU variants, offline operation,
audio compatibility, CI, dependency/SBOM policy, and a production backup/restore
workflow remain unfinished; see [CODEBASE_REMEDIATION_PLAN.md](CODEBASE_REMEDIATION_PLAN.md).

# Development toolchain

The verified workspace toolchain is Node 22.13+ (22.x), pnpm 11.22.0, and
stable Rust with rustfmt/clippy, with Rust 1.98 as the minimum supported
version. `rust-toolchain.toml` selects stable rather than an exact Rust pin;
only the Linux build/test environment is verified here.
Hosted CI runs backend/frontend smoke checks on Windows and macOS, but native
Tauri behavior on those systems and clean-machine installation remain
unverified. See
[supported environments](monorepo/docs/operations/SUPPORTED_ENVIRONMENTS.md)
for the evidence-backed v1 support boundary and LAN-first deployment guidance.
Offline recovery and migration procedures: [recovery runbook](monorepo/docs/operations/RECOVERY_MIGRATION_RUNBOOK.md).
