# Supported environments

This document records what is currently verified, rather than what the
dependencies might theoretically support.

## v1 support level

| Surface | Verified environment | Status |
| --- | --- | --- |
| Backend and web client | Linux, Node 22.x, pnpm 11.22.0 | Supported for local/LAN deployment |
| Tauri desktop client | Linux, stable Rust with Rust 1.98+ | Build/check verified; native audio depends on host devices |
| macOS and Windows desktop | Backend/frontend smoke checks only; native desktop not exercised | Not yet supported |
| Remote access | Operator-configured and trusted-origin only | Optional; not a public-network deployment |

The repository's hosted CI runs the complete Linux gate plus backend/frontend
smoke checks on Windows and macOS. The platform jobs do not run native Tauri
desktop checks, so they do not prove desktop behavior or audio works on those
operating systems.

## LAN-first deployment

The backend defaults to loopback. For a trusted LAN deployment, an operator
may deliberately set `IRIS_HOST`, `IRIS_PORT`, `IRIS_BACKEND_URL`, and
`IRIS_TRUSTED_ORIGINS` for the chosen topology. Keep the data directory,
credentials, service configuration, and files-provider root on trusted hosts.
Do not expose the service to the public internet in v1.

## Before claiming another platform

Run the complete repository verification on the target operating system and
record the operating-system version, Node/pnpm versions, Rust toolchain,
desktop build result, and audio-device result. Until that evidence exists,
report the platform as unverified rather than supported.

See the [root README](../../../README.md) and [remediation plan](../../../CODEBASE_REMEDIATION_PLAN.md)
for current limitations and the work required to broaden platform support.
