# Admin control plane and runtime orchestration

Design record for the planned remote-capable backend administration GUI. This
document is the source of truth for the feature; the roadmap links here so the
decisions survive context changes.

## Goals

- Replace the growing interactive setup wizard with a schema-driven admin GUI.
- Support headless/blade servers through secure remote administration.
- Discover, connect to, test, and optionally supervise LLM, TTS, STT, and
  ComfyUI services without requiring Iris to own their installations.
- Cover every setting currently available through the CLI, including users,
  profiles, credentials, networking/TLS, tools, prompts, models, and voices.
- Offer an optional AI-guided final setup while preserving human approval,
  a complete checklist, secret isolation, validation, audit, and rollback.
- Make the CLI a recovery/automation client of the same admin API rather than
  an independent configuration implementation.

## Non-goals and boundaries

- Runtimes, virtual environments, executables, and models are not required to
  live under Iris. Existing shared services must remain reusable by other apps.
- Iris must not stop, restart, upgrade, or replace a process it did not start.
- A listening TCP port is not proof that the intended service is healthy.
- The AI never reads keys/private secrets and never applies configuration or
  executes proposed commands without explicit human approval.
- Do not mount live config/auth/key databases into the general files or shell
  sandbox. A sanitized export may be edited and imported through validation.
- No setup operation should require `sudo`. System-level installation remains
  an explicit administrator task outside Iris.

## Remote bootstrap and authorization

The GUI must be usable remotely, including before a normal administrator
exists, without exposing an unauthenticated LAN control surface.

1. Default bootstrap is localhost-only and works through an SSH tunnel.
2. Direct remote bootstrap requires an explicit bind option. Iris prints a
   short-lived single-use token and, for temporary self-signed TLS, the
   certificate fingerprint to the server terminal.
3. The first administrator creates an account; successful creation permanently
   invalidates the bootstrap token.
4. After bootstrap, every admin endpoint requires a BetterAuth administrator
   session. Support session listing/revocation; leave room for MFA.
5. State-changing requests require normal CSRF/origin protection. Sensitive
   actions require recent authentication or credential re-entry.

TLS setup modes:

- localhost-only HTTP;
- existing certificate and key paths;
- generated self-signed certificate for local/LAN use;
- reverse-proxy mode;
- optional ACME only when hostname/network prerequisites are verified.

The GUI validates hostname coverage, expiry, file readability/permissions, and
trusted origins before applying network changes. Changes that could disconnect
the current administrator need a confirmation/rollback window.

## External service definitions

LLM, TTS, STT, and ComfyUI use the same lifecycle model with service-specific
protocol adapters. Each definition has exactly one of these modes:

- `connect-only`: use and health-check an existing endpoint; never manage it.
- `start-and-manage`: launch the configured executable, then supervise only
  that exact child process.
- `connect-or-start`: reuse a healthy endpoint; otherwise acquire a start lock,
  launch the executable, and wait for protocol-level readiness.

Process launch uses one executable plus an argument array, working directory,
and environment. There is deliberately no arbitrary shell-string option: a
user needing shell composition can provide a wrapper executable. Environment
secrets are references to the key store and are redacted from previews/logs.

The built-in TTS preset is audio.cpp. It launches `audiocpp_server` with a
schema-generated server JSON containing the selected model id, family, model
path, backend, device, thread count, lazy-load setting, and optional default
voice preset. The `{audioCppConfig}` process argument is replaced with the
private generated file at service start. audio.cpp's `/health`, `/v1/models`,
and `/v1/audio/speech` endpoints are used by the service probe and TTS provider.
Commands run as the Iris service account and Iris never invokes `sudo`.

Example definition:

```yaml
name: shared-ik-llama
kind: llm
mode: connect-or-start
endpoint:
  baseUrl: http://127.0.0.1:8080
  healthCheck:
    protocol: openai-model-list
  startupTimeoutSeconds: 120
process:
  executable: /opt/ik_llama/bin/llama-server
  arguments: [--model, /models/gemma.gguf, --port, "8080", --n-gpu-layers, "99"]
  workingDirectory: /opt/ik_llama
  environment:
    HIP_VISIBLE_DEVICES: "0"
shutdownPolicy: leave-running
```

Lifecycle invariants:

- Record PID plus process-start identity for children Iris launches.
- Never signal a pre-existing/foreign process, even if it owns the endpoint.
- Health checks verify the expected protocol/model capabilities, not just TCP.
- `connect-or-start` uses a cross-process lock to avoid duplicate launches.
- Shutdown policy for owned children is explicit (`leave-running` or
  `terminate-owned`). Shared endpoints default to leave-running.
- Capture bounded/redacted logs and expose readiness/failure diagnostics.
- Local services can be probed for hardware; remote services must advertise
  capabilities or use explicit administrator declarations.

Future remote-start adapters (SSH, systemd agent, Docker API, Kubernetes) are
explicit service backends. A local command is never silently treated as remote.

## Discovery and runtime setup

Discovery must be advisory and non-destructive:

- OS/architecture, CPU features, RAM, disk;
- NVIDIA/CUDA, AMD/ROCm, Vulkan, and Apple Metal where applicable;
- executables found through explicit paths, PATH, known locations, and running
  service endpoints;
- models/directories and likely formats;
- runtime version/help output and protocol health/capability probes.

Do not depend on an executable being called `llama-server`; forks such as
`ik_llama`, renamed binaries, and wrapper executables are valid. Let users point
to any executable and arguments. When no runtime is found, offer either an
external path/endpoint or an Iris-managed user-space download. Managed installs
are versioned under the data directory, never system-wide, and never use sudo.

Acceleration is chosen per service/profile only among combinations supported
by that runtime: CPU, CUDA, ROCm, Vulkan, Metal, or remote. Test-load before
committing, show predicted/observed memory, and warn about LLM/TTS/STT GPU
contention. Support unload-on-idle and fallbacks.

ComfyUI uses a dedicated adapter: discover nodes/models, submit workflows,
follow progress, retrieve outputs, and manage reusable workflow templates. It
must not be presented as an OpenAI-compatible service.

## Profiles, models, voices, and users

Runtime profiles bind service definitions, models, devices, resource policy,
and fallbacks into named modes such as lightweight/local-quality/remote.
Profiles do not imply that Iris owns the referenced services.

Model management can register existing paths without copying, download into a
managed cache, inspect format/size/quantization, test-load, and remove only
managed assets. Never delete an externally registered model.

TTS voice management lists built-ins, previews a standard sentence, stores
language/style defaults, and optionally registers owned reference audio plus
transcript for cloning. Show ownership/consent and deletion controls.

User management covers add/rename/disable/delete, admin role, password/PIN
reset, self-service credential changes, and session listing/revocation.

## TTS playback cache

TTS generation is immediate playback, not a permanent chat attachment. The
tool result carries a stable playback ID and renders a Replay button. Metadata
stores the original text, language, voice, style instruction, service/profile,
and model identifier; raw WAV never enters model context.

- If cached audio exists, replay streams it through an authenticated endpoint.
- If evicted, replay regenerates from stored metadata without an AI call.
- Regeneration is single-flight and may differ if runtime/model configuration
  changed; retain enough identity to detect/report that.
- Cache is bounded by optional maximum age and maximum bytes; exceeding either
  constraint evicts least-recently-used entries.
- Cleanup runs at startup and after writes; replay updates last access.
- A disk-cache-disabled mode retains the current short-lived memory behavior.
- Access is restricted to authorized members of the originating chat.

## Audio tool redesign and STT fallback

Models must never generate or copy base64 audio. Audio bytes move internally;
the AI sees handles and metadata.

- `audio_play` accepts a sandboxed file, authenticated chat attachment, or
  trusted transient handle and streams directly to the user's output device.
- `audio_read` records transiently. For an audio-capable participant, Iris
  injects `input_audio` internally into the next inference request.
- Audio-input capability is explicit per service/model profile and tested; it
  is never inferred merely from “OpenAI compatible.”
- For text-only models, a configured STT side service transcribes the recording
  and injects the transcript instead.
- Recordings are saved only when the user explicitly requests persistence.
- Binary payloads bypass persisted/truncated tool-result content.

Suggested AI surface:

```text
audio_devices()
audio_play({source:{kind:"file"|"attachment"|"handle", ...}})
audio_read({seconds, send_to_model:true})
audio_stop()
```

## Configuration and prompt administration

The GUI exposes all setup/CLI state through typed schemas:

- server binding, public URL, origins, TLS;
- service definitions, profiles, models, resource policy;
- users/sessions/credentials;
- provider internal functionalities versus AI allowlists;
- file/docs roots, container/runtime settings, timeouts, and approvals;
- core prompts plus generic/per-function tool prompts;
- TTS/STT/audio/cache settings and voices;
- import/export, validation, tests, audit, and rollback.

The config DB remains authoritative; YAML remains bootstrap/export only. Prompt
resolution remains DB override > prompt file > built-in. The GUI shows the
effective prompt and origin and can restore defaults.

## AI-assisted setup

After minimum viable setup, offer an optional dedicated admin chat with a
special system prompt generated from the current configuration schemas. The AI
uses constrained semantic tools rather than general files/shell access:

```text
setup_list_sections
setup_read_section
setup_get_options
setup_propose_patch
setup_validate_patch
setup_test_patch
setup_apply_patch
```

Rules:

- Secret fields expose only `unset`/`configured`/`invalid`; values are never
  readable by the model or included in diffs/logs.
- Proposals are staged and immutable; validate/test before Apply is available.
- The human sees a field-level diff and approves each section. Software
  download, process launch, network/TLS changes, destructive actions, and
  executable changes require distinct explicit approval.
- AI proposals cannot bypass schemas or capability checks. Applied changes get
  audit entries and rollback snapshots.
- If file-oriented editing is useful, export a sanitized snapshot to a
  temporary isolated workspace and import through the same validation path.

## Checklist

The application, not the model, owns a schema-derived checklist. Every item is
`not configured`, `configured but untested`, `verified`, or `explicitly
skipped`. Validators and explicit human choices update status; AI conversation
alone never marks completion.

Required groups include foundation/security/TLS, administrator and sessions,
LLM runtime/model test, TTS/STT decision and test, resource contention policy,
tool internal access, AI allowlists, approvals/folder boundaries, core/tool
prompts, voice preview/cloning policy, and cache policy. The AI receives the
live checklist and should work through remaining items without being the source
of truth.

## Implementation sequence

1. Define versioned admin schemas, redaction rules, validation results, staged
   patches, audit entries, rollback snapshots, and checklist states.
2. Add localhost/remote bootstrap and authenticated admin API; adapt CLI to it.
3. Build the GUI shell for status, staged diffs, apply/rollback, and diagnostics.
4. Add discovery and external service definitions/lifecycle supervision.
5. Add profiles, model registration/testing, and resource policy.
6. Add users/sessions and TLS/origin workflows.
7. Add tool permissions/settings and effective prompt editors.
8. Add TTS voices and bounded replay/regeneration cache.
9. Redesign audio handles/input and add STT fallback/capability declarations.
10. Add ComfyUI adapter and workflow management.
11. Add the constrained AI-assisted setup chat and schema-owned checklist.
12. Migrate remaining CLI-only paths to the shared API and run end-to-end
    security, remote-headless, failure/recovery, and packaging tests.

## Implementation status

As of 2026-08-26:

### Complete

- [x] Versioned/redacted configuration; real validation and protocol tests;
  staged diffs, approvals, audit, optimistic concurrency, and rollback.
- [x] Peer-address-checked local bootstrap with explicit remote opt-in,
  atomic single-use tokens, BetterAuth administrators, trusted-origin checks,
  user/password/role/session administration, and named write-only keys.
- [x] Typed remote `/admin` workflows for server/origins, services, profiles,
  tools/allowlists, prompts, speech cache, users, models, approvals, apply, and
  rollback, with advanced schema editing as an escape hatch.
- [x] External service connect/manage/connect-or-start modes, protocol-aware
  probes, cross-process locks, owned-child identity, bounded redacted logs, and
  foreign-process protection.
- [x] CPU/CUDA/ROCm/Vulkan/Metal discovery, executable/model discovery,
  external/managed registration, profiles, and TLS validation.
- [x] Persistent bounded TTS replay with post-eviction regeneration, chat
  authorization, opaque recording handles, explicit native-audio capability,
  and STT fallback injection.
- [x] ComfyUI native operations, persisted workflows, history/queue/stats, and
  authenticated output retrieval.
- [x] Administrator-only guided setup chat with secret-redacted semantic tools;
  it may stage/validate/test but cannot approve or apply.
- [x] Standalone `willReply` preflight removed; silence belongs to `noReply`,
  author prefixes work, and blank-line/`<new-message>` routing is tested.

### Incomplete

- [ ] MFA/recent-authentication and credential re-entry for sensitive changes;
  TLS/network disconnect rollback windows and trusted-proxy configuration.
- [ ] Runtime-specific acceleration test-loads, measured memory reporting, GPU
  contention scheduling, unload-on-idle, and enforced fallbacks.
- [ ] Signed/checksummed managed runtime and model downloads with progress,
  cancellation, pinning, and owned-asset deletion.
- [ ] Explicit recording-persistence UI and cross-platform audio/device tests.
- [ ] ComfyUI websocket progress, cancellation, parameter forms, and output
  gallery UI on top of the persisted workflow/output APIs.
- [ ] Complete CLI migration to the authenticated admin API.
- [ ] Remote-headless, recovery, security, packaging, and end-to-end matrices.

Implemented foundations and integrations:

- Versioned Zod admin schema, secret-state redaction, staged immutable patches,
  validation/test/apply gates, optimistic version checks, audit entries, and
  rollback snapshots in `IRIS_DATA_DIR/admin.db`.
- Existing `setup.json` is imported on first admin-state creation; approved
  server/default-model changes are synchronized back without replacing
  unrelated legacy settings.
- Localhost bootstrap token issuance, expiry, single-use consumption, and
  first-administrator creation through BetterAuth.
- Administrator-only status, patch, audit, checklist, user/session, prompt,
  discovery, model, service, ComfyUI, and STT endpoints.
- Explicit service modes, protocol probes, executable validation, start locks,
  bounded/redacted child logs, process identity records, readiness polling, and
  owned-child-only stopping.
- Host/runtime discovery, external/managed model registration, profile
  reference validation, TLS/origin validation, and schema-owned checklist.
- Constrained setup semantic tools and prompt override/default restoration.
- Staged patches expose approval classifications for standard, network/TLS,
  executable, download/managed-asset, and destructive changes in the GUI.
- Persistent bounded TTS cache, chat-bound replay/regeneration, opaque audio
  handles, explicit native-audio/STT routing, and native ComfyUI workflows.
- Typed `/admin` GUI plus an advanced full-snapshot editor.
- CLI `admin status` and `admin discover` commands; prompt tests no longer
  treat `willReply` as a separate prompt. `<no-reply>` remains owned by the
  `noReply` protocol.

Remaining work is intentionally tracked only in the root `roadmap.txt`.
