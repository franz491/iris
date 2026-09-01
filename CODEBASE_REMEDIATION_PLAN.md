# Iris codebase remediation plan

Status: active remediation. Created 2026-08-28; last audited 2026-09-01.

Product decision (2026-09-01): v1 is LAN-first with remote access optional and
operator-controlled. MFA is explicitly deferred to post-v1 hardening; revisit
before enabling internet exposure or when the deployment threat model includes
multiple mutually untrusted users. This does not relax the current recent-auth,
CSRF/trusted-origin, trusted-source, session, or optional remote-access
protections.

Dependency remediation (2026-08-29): GHSA-gpj5-g38j-94v9 (high severity)
was confirmed through the direct backend `drizzle-orm` dependency and Better
Auth's Drizzle adapter peer path, which had resolved `drizzle-orm` 0.40.1.
The backend constraint and pnpm lockfile now resolve `drizzle-orm` 0.45.2,
which satisfies the adapter peer range and the patched-version floor. The
existing Drizzle imports, SQLite schemas, migrations, and Better Auth setup
typecheck and backend tests without source changes. `pnpm audit
--audit-level high` reports no known vulnerabilities at this audit time;
future audit results depend on the advisory database and dependency graph at
the time they are run.

Current verification snapshot (2026-09-01; final verified gate): full
verification passes with 861 tests in 166 backend
files and 129 tests in 24
frontend files; backend/frontend builds and 25 Rust tests pass.
Critical
coverage passes with 83.33% statements/lines, 78.16% branches, and 86.11%
functions; `api/auth.ts` is at 82.50% statements/lines, 89.18% branches, and
82.92% functions.
TypeScript, Svelte, Rust formatting, and Clippy
(`-D warnings`) gates pass; license validation covers 276 packages. Both
`clean:check:test` and `clean:check` pass. The separate network-backed
`pnpm audit --audit-level high` reports no known vulnerabilities; it is kept
outside deterministic `pnpm verify`.
The scheduler retention apply E2E verifies exact older-pair deletion, newest
pair preservation, apply/completion/failure counters, active gauge balancing,
duration recording, and path-free metrics snapshots. Latest accessibility and
observability suites remain green.
Post-route-extraction backend verification (2026-09-01) passes with 848 tests
in 165 backend files, including the mutation/read schema ownership and API
validation suites. This is a backend-only rerun; it does not supersede the
latest full frontend/Rust gate above or claim a frontend/Rust rerun.
The deterministic SPDX/SBOM check inventories 773 packages and removes its
temporary serialized output; artifact checksums are manifest-scoped and do not
claim signing or provenance.
The verification build recreates `backend/dist`, `backend/coverage`, `frontend/dist`, and
`frontend/src-tauri/target`; these are the only permitted generated outputs for
`pnpm clean:check`, while unexpected generated artifacts still fail.
The subsequent focused native run adds one Rust regression test (25 Rust tests
in that post-gate run); it is recorded separately and does not change the
counts of the complete gate above.

Audited progress estimate (2026-09-01): approximately **79% of the full plan**
(reasonable range 76–82%), approximately 97–99% of the immediate repository and
security-foundation tranche, and less than 30% of production-readiness work.
Of 30 tickets, 14 are fully complete, 1 is superseded by a scope decision, 1
is partially complete, and 14 are in progress. No ticket is currently
unstarted.
A 98%
completion claim is not supported by ticket acceptance criteria or release
gates. Partial security mitigations are not counted as complete when their
intended contract or an important boundary remains missing.

Authoritative blocking findings and remaining gates (2026-08-29): recipient-
scoped post-completion SSE replay, done, and truncation are safe; the selected
buffer-until-routing protocol prevents pre-routing disclosure, while true live
tokens and pre-routing audio lifecycle events remain intentionally deferred;
the Tauri file jail is descriptor-relative on Unix but fails closed on other
platforms, and PTY descendant termination remains platform-dependent; sign-in
throttling now uses hashed SQLite state shared across instances, while MFA is
deferred to post-v1 hardening,
broader step-up/session coverage, and operational tuning remain; encrypted API-key storage and supported rotation are implemented,
but OS-keyring integration and production recovery exercises remain; signed/
checksummed artifact distribution remains (installer staging/disk checks are
implemented);
the streaming model-completion transport is DNS-pinned and bounded; policy
consolidation remains; the service/ComfyUI/shared outbound policies should be
consolidated; and native audio validation, format handling, cancellation, and
lifecycle coverage are implemented. MFA is deferred pending the stated review
trigger, while backend recent-auth
grants/enforcement and the accessible frontend recent-auth prompt/single-retry
flow are implemented and tested. Broader step-up/CSRF/session coverage,
migration rollback drills, hosted CI execution,
vulnerability/update policy, API/component decomposition, package/upgrade/
rollback validation, signed artifacts/SBOM, and manual accessibility/UX QA
remain. Request correlation/access logging, shutdown draining, modal/form
accessibility, and the admin user client have bounded implementations and
regression coverage. Progress paragraphs below are an audit
trail; this summary and each ticket heading are the current status sources.

### Execution status

Fully complete:

- IRIS-000 — inventory and retention policy. `DATA_LIFECYCLE.md` records the
  source/runtime split and target locations; `.gitignore` establishes the
  future repository policy.
- IRIS-010 — server-side whisper privacy. Network-level message, stream,
  reconnect, polling, truncation, audio, and absent-scope tests establish that
  unauthorized recipients receive no content. The explicit buffer-until-routing
  protocol suppresses live content until a uniform audience is known; mixed
  audiences remain fail-closed, with lifecycle-only completion events scoped to
  the union. True token-by-token routing and pre-routing audio are deferred by
  protocol choice, not an acceptance gap.
- IRIS-020 — one workspace/lockfile and explicitly scoped first-party Vitest
  suites with temporary backend data isolation.
- IRIS-021 — clean-output policy and external audio-service lifecycle are
  explicitly documented and verified; known build/coverage outputs are allowed
  while unexpected generated/runtime artifacts fail the check.
- IRIS-031 — chat orchestration seams are extracted with explicit generation,
  interruption, routing, event, persistence, tool-loop, cache, and frontend-
  tool wait ownership; lifecycle and HTTP SSE race evidence satisfies the
  ticket acceptance.
- IRIS-033 — versioned migration ledgers cover all nine application-owned
  families with status/dry-run CLI checks, historical fixtures, rollback tests,
  and offline recovery documentation/drill.
- IRIS-041 — stable JSON API responses use shared runtime primitives and typed
  client/component validators; SSE, binary, vendor, and install-stream paths
  are explicitly typed/documented exceptions.

Superseded scope decision (not completed engineering):

- IRIS-001 — superseded by the explicit project instruction that all current
  database/runtime data is disposable. Future user data still requires
  migration, backup, restore, and recovery design before any production claim.
  Reopen this ticket if that disposable-data instruction was not explicitly
  authorized.

In progress or partially complete:

Verification baseline (2026-08-30): backend 73 files/377 tests passed;
frontend 20 files/114 tests passed; frontend/backend builds, formatting, lint,
typecheck, CI/license/secret checks, critical coverage, and Rust
format/clippy/tests (24 Rust tests) passed. Remaining known gaps include
provider-side live routing metadata, hosted CI evidence, and broader recovery,
platform, and production-policy work.

- IRIS-002 — Node/pnpm engine and package-manager requirements are declared;
  stable Rust with rustfmt/clippy is selected and native Cargo declares Rust
  1.98 as its minimum. Linux is the only platform verified; clean-machine and
  other-OS verification remain incomplete.
- IRIS-010 — server filtering prevents cross-user whisper disclosure and tool
  requests are recipient-scoped. Completed replies now replay buffered stream
  and done packets only after deriving the persisted audience; mixed-audience
  generations suppress content replay, while public truncation events broadcast.
  True token-by-token delivery and pre-routing audio events remain suppressed
  until generation supplies audience metadata before content.

- IRIS-011 — explicit identity naming and initial route-policy matrix are in
  place; generic provider/plugin/audio passthroughs are removed. Chat creation,
  rewrite, tool-config, and tool-response now use explicit member/auth guards.
  The table-driven matrix now covers 52 admin endpoints plus chat, polling,
  tool, attachment, and provider policy cases (64 assertions across 16 route
  rows). Chat creation now binds and deduplicates its authenticated creator,
  rejects other client-supplied human IDs, and resolves added humans by
  registered username. Invite/consent policy, full capability-token, MFA (deferred
  to post-v1 hardening under the LAN-first decision), and
  broader step-up/session coverage remain; recent-auth grants/enforcement are
  covered by the current backend/frontend flow.
- IRIS-014 — production default data directory now uses OS application-data
  conventions and setup no longer writes into the source tree. Named provider
  keys now use AES-256-GCM with a separately supplied master key and
  transactional plaintext migration. Secure non-HTTP master-key rotation now
  authenticates every row, re-encrypts and verifies transactionally, and uses
  bounded owner-only key files. OS-keyring integration, broader data migration,
  and lifecycle-root separation remain.
- IRIS-013 — password policy, final-admin protection, and rollback-safe
  user mutation routes now revoke target sessions after successful credential
  reset/deletion and emit typed, secret-free actor/target/outcome audit rows.
  bootstrap token claims are complete. Backend recent-auth grants/enforcement
  and the accessible frontend prompt/single-retry flow are implemented and
  tested; MFA is deferred to post-v1 hardening under the LAN-first decision,
  while broader step-up/CSRF/session policy work remains. Failed
  sign-ins now have a bounded SQLite limiter that separates
  low per-source and higher per-account thresholds,
  ignores untrusted forwarding headers, and resets account state on successful
  login. Hashed keys, atomic updates, expiry, bounded eviction, and two-instance
  contract tests establish restart/multi-instance coordination; MFA remains
  deferred to post-v1 hardening, while broader step-up/session policy remains.
- IRIS-012 — shared binary and streamed JSON limits now protect the highest
  risk attachment/audio/API paths; admin STT uploads and upstream search/TTS
  responses are bounded as well. Strict schemas now cover chat creation,
  rewrite, tools, account/configuration mutations, and native install
  selection. Chat settings and polling query boundaries are now also strict.
  OpenAI-compatible SSE responses now enforce 8 MiB total and 256 KiB line
  bounds and cancel the reader on overflow. Attachment downloads are bounded
  during provider reads; exclusive upload plus compensating deletion covers
  ordinary message failures without overwriting existing files. Durable,
  chat-bound staging plus idempotent startup reconciliation now covers process
  crashes and failed compensation. Remaining JSON routes, broader throttling,
  and cancellation outside this adapter remain.
- IRIS-015 — restrictive CSP/capabilities, symlink-safe documentation
  traversal, bounded documentation scanning, Docker hardening, process groups,
  and basic PTY lifecycle are implemented. Captured-shell intermediary queues,
  file-jail root symlinks, reads, and write inputs are now bounded/rejected.
  Interactive PTY output has queue, event, write, and total-session bounds with
  explicit truncation cleanup. Unix file reads and atomic writes now traverse
  from an opened root descriptor with no-follow component access; non-Unix file
  operations fail closed pending equivalent APIs. Digest pinning and platform-
  dependent descendant lifecycle gaps remain.
- IRIS-016 — service endpoint validation rejects credentials, fragments,
  unsupported schemes, cloud metadata/link-local targets, and probe redirects;
  service probes pin validated DNS results into the actual HTTP(S) connection,
  reject private/mapped/multicast targets, retain hostname-correct TLS, and
  enforce response bounds. Managed installers now require immutable revisions,
  exact ownership manifests, hash-locked ComfyUI dependencies, bounded logs,
  minimal environments, and abort/timeout process-tree cleanup. Production
  ComfyUI requests now use resolve-once pinned connections with JSON/binary
  streaming limits. Signed artifact distribution remains. A shared pinned
  transport now protects model discovery, non-streaming model
  calls, TTS, STT, and search with bounded responses and cancellation. Streaming
  model completions and policy consolidation remain.
- IRIS-022 — deterministic TypeScript/Svelte/Rust gates, repository formatting,
  secret/license checks, critical coverage, and a least-privilege Linux GitHub
  Actions workflow are implemented. Hosted CI execution, vulnerability
  audit/update policy, broader thresholds, and Windows/macOS/packaging jobs
  remain.
- IRIS-060 — logger sanitization now redacts common authorization, cookie,
  token, password, secret, and API-key forms before console/file output;
  structured audit/export redaction and retention remain.
- IRIS-042 — the admin install path now uses typed install request/result and
  event boundaries instead of its prior untyped response handling; broader
  component decomposition and accessibility coverage remain.
- IRIS-043 — ToolSettingsModal and SettingsModal now have labelled dialogs,
  Escape dismissal, initial focus, and focus return on unmount; broader modal
  coverage remains. Settings validation and credential outcomes now expose
  non-secret live status/error announcements and associate backend URL errors.
  Tool configuration save/import failures and successful override saves now
  also populate an accessible live feedback region alongside existing toasts.
  Login validation failures are now assertive alerts associated with the
  credential field and return focus to that field; loading remains disabled.
- IRIS-040 — existing generation/logout guards now also cover compaction
  refresh; full domain-store decomposition and event deduplication remain.
- IRIS-030 — duplicate auth registration was removed; domain extraction and
  centralized middleware have not begun materially.
- IRIS-032 — message sequence insertion, participant/AI-participant paired
  writes, chat creation, attachment/message persistence, and the covered
  repository transactions now have rollback/concurrency evidence. The
  remaining decomposition work is recorded as architecture follow-up rather
  than an unproven atomicity defect.
- IRIS-034 — several unsafe provider boundaries were validated and typed; the
  generic provider contracts and complete remote-response normalization remain.
- IRIS-070 — initial architecture/decision indexes and ADRs exist; legacy
  documentation reconciliation and the complete hierarchy remain.

IRIS-031 now has implementation and race evidence; IRIS-071 is complete. See
`monorepo/docs/roadmap-disposition.md` for the authoritative dispositions.

## 1. Purpose and working rules

This plan turns the current snapshot into a maintainable, testable, secure
monorepo without attempting a big-bang rewrite. Agents should work in the order
defined below, keep changes narrowly scoped, and prove behavior before deleting
compatibility code or runtime data.

Non-negotiable rules for every implementation agent:

1. Current databases and their runtime state are disposable and may be deleted
   without backup/export. Do not infer that separate user-file/media trees are
   disposable: delete those only when explicitly authorized. The snapshot mixes
   application state, third-party software, and source, so cleanup must still
   classify a target before removing it.
2. Treat security boundary changes, schema migrations, history rewriting,
   compaction, tool execution, and service ownership as high-risk. Add regression
   tests before changing them.
3. Make one conceptual change per agent. Do not combine formatting the
   whole repository with behavior changes.
4. Replace unsafe compatibility behavior only after modifying its callers. This repo
   is not in production - breaking changes are encouraged when useful.
5. No new `any`, unchecked request-body casts, unbounded buffers, shell strings,
   or client-only authorization checks.
6. Every completed ticket must update relevant durable documentation and remove
   stale commentary that describes the old behavior.
7. Generated outputs and local runtime state must never be accepted as source.

## 2. Audit scope and verified baseline

Audited areas:

- pnpm workspace and all package manifests/configuration;
- backend TypeScript under `monorepo/backend/src` and first-party tests;
- frontend Svelte/TypeScript under `monorepo/frontend/src` and tests;
- Tauri Rust commands, capabilities, and application configuration;
- roadmap, working memory, guidelines, and architecture documents;
- repository/runtime layout and large generated/vendor trees.

Snapshot facts (refreshed 2026-08-29):

- The previously observed source-size and runtime-data figures are historical;
  generated build outputs were cleaned and the current workspace has no active
  database/runtime data tree. The largest remaining maintainability concern is
  the still-minified admin control-plane component.
- Root README, ignore policy, Vitest configuration, partial quality gates, and
  clean-output checks now exist. The command named `lint` currently provides
  TypeScript/Svelte checking rather than ESLint policy enforcement, and package
  formatting coverage is incomplete. CI, coverage, dependency/license/secret
  scanners, and signed-artifact policy remain open.
- The snapshot contains no usable Git metadata. Exact attribution, diffs,
  tracked/untracked verification, clean-checkout reproducibility, rollback, and
  history-based credential review therefore cannot be audited. This is an
  evidence limitation, not a passed release gate.
- Current backend `tsc --noEmit` passes. Current frontend `svelte-check` passes
  with zero diagnostics.
- The explicit first-party backend suite passes 244 tests in 42 files. The
  frontend suite passes 53 tests in 8 files.
- Backend TypeScript unused checks now pass. Production `any`, unsafe boundary
  assertions, minified files, and oversized lines still require separate policy
  and refactoring work.
- Several admin and control-plane files remain effectively minified: dozens of
  lines exceed 300 characters; the longest observed production line is about
  2,918 characters. This materially harms reviewability and remains open under
  IRIS-022/042.

## 3. Priority summary

### P0: resolve before exposing Iris to untrusted users or networks

- Bind every human participant in chat creation to an authorized server-side
  identity and always include/authorize the creator. Reject arbitrary client
  `userId` association and add negative tests for involuntary enrollment,
  impersonation, and creator exclusion.
- Preserve the server-side whisper fix while designing recipient-scoped
  `stream`, `done`, `audio_ready`, and `truncated` delivery. Test both absence of
  cross-user bytes and correct live behavior for the intended recipient.
- Make attachment plus message persistence atomic, remove orphan files on every
  failure, and enforce download bounds before providers read/base64-encode the
  complete file.
- Close native memory/filesystem gaps: bound shell reader queues and PTY output,
  reject/canonicalize a symlinked file-jail root, bound file reads and write
  inputs, and use race-resistant descriptor-relative/no-follow access.
- Replace plaintext API-key storage and complete the remaining MFA/recent-auth
  and session-policy work around the now shared SQLite sign-in limiter.
- Complete DNS-resolution/rebinding policy, checksummed/pinned managed downloads,
  installer ownership/cancellation, and foreign-process protection.

### P1: restore trustworthy engineering feedback

- Scope Vitest to first-party tests and exclude data, virtualenvs, dependencies,
  builds, models, and generated trees.
- Add linting, formatting, unused-code enforcement, test isolation, coverage
  thresholds, Rust checks, and CI.
- Consolidate workspace ownership to one root lockfile and one workspace file.
- Remove generated/dependency/runtime artifacts from source control after the
  data migration and backup gates pass.
- Break up the API, chat, database, frontend state, tool executor, and admin UI
  monoliths without changing behavior.

### P2: correctness, maintainability, and product quality

- Introduce versioned database migrations and transactions for multi-row writes.
- Centralize request/response schemas, authorization policy, errors, limits,
  logging, and cancellation.
- Separate frontend state by domain and eliminate stale async-update races.
- Repair native audio format/resampling support and add platform tests.
- Complete or explicitly defer the unfinished roadmap items; eliminate duplicate
  numbering and obsolete compatibility notes.
- Add accessibility, performance, packaging, operations, and recovery coverage.

## 4. Phase 0 — preserve state and establish a reproducible baseline

### IRIS-000: inventory source, runtime state, and ownership — INVENTORY COMPLETE

Scope: repository root and all current `data`, `dist`, `target`, `node_modules`,
cache, lock, model, and third-party software locations.

Actions:

- In a real Git clone, record tracked/untracked/ignored status, file counts,
  sizes, owners, permissions, and checksums for large assets. Do not infer
  tracking from this snapshot.
- Classify every top-level tree as source, generated, dependency, user data,
  secret, cache, model, managed third-party runtime, or disposable test output.
- Search commit history for accidentally committed databases, credentials,
  bootstrap tokens, API keys, user content, and model/license violations. If
  found, rotate secrets first, then use an approved history-cleaning procedure.
- Document which third-party runtimes Iris owns versus merely connects to.

Acceptance: a checked-in inventory contains owner, retention rule, backup rule,
and target location for every non-source tree; suspected secrets are rotated.
Git tracking/history inspection is intentionally not applicable until this
project adopts Git.

### IRIS-001: backup, export, and restore drill — SUPERSEDED

Superseded for the current snapshot by the user's explicit instruction that all
database and runtime data is throwaway and can be deleted safely. Do not treat
this as a future production-data policy.

Scope: `backend/data`, all SQLite DB/WAL/SHM sets, `setup.json`, prompts, files,
TTS cache metadata, registered models, managed software, and service configs.

Actions:

- Stop writers or use SQLite's online backup API; never copy a DB separately
  from active WAL state and assume it is consistent.
- Build a versioned export manifest with schema versions and hashes. Exclude
  regenerable caches while preserving their metadata if replay depends on it.
- Restore into a new temporary data directory and run read-only smoke tests.
- Write rollback instructions before any path migration.

Acceptance: an automated restore produces usable users, chats, prompts, config,
keys, cards, and attachments from the backup; results are documented.

### IRIS-002: define supported environments — IN PROGRESS

Progress (2026-08-28): the workspace root now declares `pnpm@11.22.0` and a
Node 22 engine range, and the README reflects the remaining unpinned Rust and
platform support.

Progress (2026-09-01, supported-environment review): the root README and
supported-environments document now agree with the manifests and hosted CI:
Linux is the complete verified gate, while Windows/macOS provide
backend/frontend smoke coverage only; native desktop support remains
unverified. The documents record Node 22.x, pnpm 11.22.0, Rust 1.98+, LAN-first
deployment, and the correct relative links. Platform/version, hardware/audio,
and clean-machine evidence remain open, so IRIS-002 stays IN PROGRESS.

- Pin Node, pnpm, Rust, and platform requirements (`packageManager`, engines,
  toolchain file, and corepack instructions).
- Decide supported Linux/macOS/Windows versions and CPU/GPU/audio variants.
- Record offline expectations and which tests may use network/hardware.
- Add a small root README with architecture, setup, development, test, data
  directory, security model, and recovery links.

Acceptance: a clean machine can install and run checks using documented pinned
versions without consulting `memory.txt`.

## 5. Phase 1 — close security and privacy boundaries

Run IRIS-010 through IRIS-016 before structural refactors. Security PRs should
be small, independently reviewable, and backed by negative tests.

### IRIS-010: enforce whisper privacy on the server — COMPLETE

Primary files: `backend/src/api/api.ts`, `backend/src/chat/chat.ts`,
`backend/src/chat/ai-participants.ts`, `frontend/src/lib/state.svelte.ts`, SSE
tests.

- Stop broadcasting raw live/final chat packets to clients that cannot read
  them. Client-side `canRead` and `canSeeLive` may remain defense-in-depth, but
  must not be the confidentiality boundary.
- Choose an explicit live-stream protocol: either determine recipients before
  emitting content, buffer until routing is known, or create recipient-scoped
  streams. Do not leak partial text and hope a later `@tag` hides it.
- Hydrate recipients and role data once per event and filter message, thought,
  tool, audio, compaction, rewrite, and truncation events consistently.
- Add multi-connection tests proving a non-recipient receives zero bytes of a
  human-involved whisper, including partial streaming, reconnect, and polling.

Acceptance: network-level tests (not DOM assertions) show no unauthorized
content in SSE, history, polling, errors, logs, or audio events.

Progress (2026-08-29): cross-user disclosure remains fail-closed. The selected
buffer-until-routing protocol replays uniform-audience `stream` packets only
after final routing and emits scoped `done`; mixed-audience generations
suppress content replay rather than unioning audiences, while lifecycle
completion reaches the union and public truncation events reach all members.
Producer and network tests cover private, public, mixed-recipient, reconnect,
absent-scope, deleted-chat, and audio lifecycle behavior. The model path does
not claim token-by-token live delivery: buffering until an authoritative
audience exists is the documented protocol, and pre-routing audio is likewise
withheld. This satisfies the accepted privacy boundary without inferring
recipients from partial text.

Closure (2026-08-31): network-level tests prove that unauthorized recipients
receive zero bytes across SSE, history, polling, errors, logs, and audio events;
unknown recipients fail closed. Scoped audio and deleted-SSE live behavior are
covered, and buffered replay preserves the routing invariant.

### IRIS-011: replace ambiguous identity helpers with explicit policy — IN PROGRESS

Primary files: all backend API routers and `chat/auth.ts`.

- Rename/split `requireUser` into `resolveViewer` (registered or shared guest),
  `requireAuthenticatedUser`, `requireChatMember`, and `requireAdmin`.
- Create a route-policy matrix for every endpoint. Default new routes to deny.
- Restrict generic provider execution to a narrow allowlist and proper role/chat
  capability. Never let a guest directly call shell, files, docs, memory, audio,
  TTS, admin setup, or future providers merely because the provider is active.
- Either remove `/api/providers/:name/:functionality` and plugin passthroughs or
  place them behind schema-validated capability tokens bound to user, chat,
  client, provider, function, expiry, and single-use/replay policy.
- Require chat authorization for `/api/tools?chatId=...`; validate client IDs
  against the active authenticated connection.
- For chat creation, always bind/include the authenticated creator and resolve
  any added human identity server-side through the currently supported
  registered-username flow. Reject arbitrary caller-supplied `userId`
  association. Any future invite/consent policy is separate follow-up work. Add
  tests for creator exclusion, user impersonation, direct-ID enrollment, and
  attempts to trigger activity in a chat the caller cannot subsequently read.
- Enforce plugin manifest method and schemas; reject duplicate/conflicting
  paths and unsafe provider mappings at registration time.

Progress (2026-08-28): `resolveViewer`, `requireAuthenticatedUser`,
`requireChatMember`, and `requireAdmin` now express the core policy. The
matrix lives in `monorepo/backend/docs/API_ROUTE_POLICY.md`; integration tests
cover guest/non-member attachment denial and anonymous/non-admin admin denial.
The complete table-driven endpoint matrix now covers 52 non-bootstrap admin
endpoints for anonymous and non-admin callers. MFA/recent-auth checks and
remaining non-admin route coverage remain. Chat-scoped mutation routes now
use the explicit member guard, and strict request schemas reject unknown,
malformed, and out-of-range fields before state changes. Admin bootstrap and
the highest-impact account/configuration mutations also use strict schemas;
focused integration coverage brings the backend suite to 152 passing tests.

Acceptance: a table-driven integration suite covers anonymous, guest, member,
non-member, user, and admin access for every route.

Progress (2026-08-29): Chat creation now always prepends the authenticated
creator as the canonical human participant, rejects client-supplied `userId`
values for other accounts, and resolves additional human participants by
registered username. Focused integration tests cover creator binding,
deduplication by ID/canonical username, impersonation rejection, and adding
another registered user. The targeted integration suite passes 21 tests and
backend typecheck passes. Invitation/consent semantics for adding another
registered user remain a separate product-policy decision.

Progress (2026-09-01, setup authorization review): `/setup/chat` now requires
the exact intended chat, the Iris Setup participant, and exactly one nonempty-
ID administrator human participant; actor attribution comes solely from the
validated authenticated actor. Adversarial zero/one/multiple-administrator,
non-admin, wrong-chat, and malformed-participant cases are covered by 61
focused tests. Legitimate `/setup/chat` behavior remains preserved. IRIS-011
stays IN PROGRESS for invite/consent policy, capability-token protection, and
broader step-up/session coverage; deferred MFA is not counted as a v1 blocker
under the LAN-first decision.

Progress (2026-09-01, frontend-tool request identity review): pending tool
request IDs now use collision-safe allocation with exactly 16 total attempts;
exhaustion fails closed without overwrite, emission, or data leakage. Original
actor, client, and promise bindings are preserved. An adversarial allocator
count test and six focused tests cover collision and exhaustion behavior; the
review fixed an off-by-one attempt boundary. IRIS-011 remains IN PROGRESS for
invite/consent semantics and broader capability/session policy. Deferred MFA is
not counted as a v1 blocker under the LAN-first decision.

### IRIS-012: centralized validation, limits, and abuse controls — COMPLETE

Progress (2026-08-28): attachment upload/download and transient audio-handle
upload now use shared bounded-body helpers with 10 MiB limits. Oversize input
returns 413; audio handles must be WAV content with a valid RIFF/WAVE header
and invalid input returns 400. General request schemas, streaming-to-disk,
and remaining limits remain open.

Progress (2026-08-29): attachment downloads pass the 10 MiB limit into the
files provider, which reads in bounded chunks and stops at limit plus one byte.
Uploads use exclusive creation, return 409 without changing an existing file,
and compensate ordinary message-persistence failure with deletion. Seven focused
attachment tests pass. Durable crash recovery and failed-cleanup reconciliation
are now implemented below.

Progress (2026-08-29, latest): each attachment persists a bounded staging
record before file creation and clears it only after message persistence. An
idempotent startup reconciliation hook removes only files whose exact
chat/path ownership is proven by the record, preserves files with successful
messages, fails closed on malformed records, and retains records when deletion
fails so later runs can retry. This closes process-crash orphan recovery within
the SQLite-plus-provider boundary; cross-resource atomicity and provider-side
crash guarantees remain impossible without provider support.

JSON requests over 1 MiB are centrally rejected with 413 by both the main and
admin API routers before route parsing, including chunked bodies without a
Content-Length header. Admin STT uploads are capped at 25 MiB, and the admin
STT `x-filename` header is strictly validated before service lookup or body
read; empty, whitespace-only, oversized, and control-character values fail
closed with focused API coverage. Search HTML and TTS responses are
bounded before parsing/materialization. Schema validation,
streaming-to-disk, throttling, and cancellation remain follow-up work.

The chat message creation route now validates JSON with Zod, including bounded
content/thought fields, message type, and recipient IDs, and returns consistent
400 responses for malformed payloads. Focused malformed-input coverage passes;
the shared error adapter now also classifies legacy JSON parse failures as 400
validation errors. AI-card create/update and chat-stop payloads now have strict
runtime schemas with field, context, avatar, and enum bounds. The remaining
JSON routes still need schema migration.

Additional progress (2026-08-28): chat creation, history rewrite, tool
configuration/response, chat rename, and AI participant patches now reject
unknown fields and invalid bounds through strict Zod schemas. History and
polling cursors reject `NaN`, negative, non-integer, and oversized values.

Additional progress (2026-08-28): the OpenAI-compatible streaming adapter now
fails closed on oversized aggregate responses or individual unterminated SSE
lines, and cancels the upstream reader when limits are exceeded. Focused tests
cover both limits and cancellation.
Admin bootstrap, user creation/role/password changes, prompt/checklist/key
mutations, and native install backend selection now validate through the same
boundary pattern. Regression coverage verifies malformed mutations and query
cursors return `validation_error`; the backend suite now passes 161 tests.
Admin workflow/model/setup/proposal/patch and ComfyUI mutation routes now also
use strict schemas before state changes.

Progress (2026-08-31, latest): participant-add payloads now enforce strict
registered-user identity and bounded participant fields; chat-stop rejects
malformed payloads and participant identifiers beyond the configured bound; and
message recipients and all JSON mutations in these paths use strict bounded
schemas. The tool-loop executor is now an explicit validated seam, with focused
malformed-input, output-limit, and failure-containment coverage. The current
snapshot is 685 backend tests in 124 files; the complete repository gate passes.

Progress (2026-08-31, JSON deadline/abort slice): bounded JSON readers now
enforce a deterministic deadline for slow chunked bodies, propagate abort to
the request reader, and clean up the reader on timeout, overflow, abort, or
normal completion. Both main and admin routers return bounded timeout responses
before route-side state changes; focused API, JSON-limit, and abort tests cover
these paths.

Progress (2026-08-31, admission cross-review; credential flake resolved): expensive credential work is now
admitted atomically by authenticated account and trusted adapter source across
sign-in, reauthentication, bootstrap creation, admin user creation, admin
password changes, and lost-admin/CLI recovery. Invalid requests do not consume
the one-shot bootstrap key; synchronous and asynchronous failures release
idempotent leases, active work cannot expire into underflow, and rejection
responses retain deterministic JSON, `Retry-After`, and `no-store` headers.
Guest chat admission, native-install admission, and service-probe fan-out
throttling are covered by their respective account/source or bounded limiter
tests. Model-generation leases retain the same lifecycle guarantees across
multi-target reservation, persistence/scheduling failure, abort, stop,
disposal, completion, and interrupt restart.

Progress (2026-08-31, upload streaming slice): upload throttling and the
shared binary-limit boundary now run before attachment staging. The real
attachment route streams request chunks into a private 0700 temporary root
and 0600 file, validates MIME signatures from a bounded prefix, and removes
the temporary file on normal completion, overflow, source failure, or abort.
The kernel now exposes an internal stream dispatch seam and the files provider
promotes bounded streams atomically with exclusive no-overwrite semantics;
stage, stream-write, message persistence, finalization, and compensation
ordering is unchanged. Focused evidence includes exact-limit chunked and
chunked-overflow API tests (with temporary-root cleanup), direct abort cleanup,
provider overflow/source-failure cleanup, and the existing attachment fault
matrix. The focused streaming/attachment/provider/signature set passes 41
tests; the latest full verification gate passes at 124 backend files and 685
tests. Valid declared `Content-Length` values are also compared with actual
streamed request/response byte totals, failing closed on mismatch.

Progress (2026-08-31, latest): the attachment route now has an atomic,
bounded per-account and adapter-source upload limiter with deterministic 429,
Retry-After, expiry, reset, and spoof-resistant source handling. Model
generation admission now reserves capacity per authenticated account and
trusted adapter source before scheduling actual AI targets, releases an
idempotent lease on completion/failure/stop, does not expire active leases, and
avoids charging silent or no-target messages. Focused route, source-isolation,
rejection, cleanup, and admission tests pass. Service-probe fan-out also has a
bounded limiter with deterministic rejection metadata.

Progress (2026-08-31, configuration and audio-query slice): setup/config
patch, apply, and rollback mutations now use bounded account/source admission
before expensive validation and projection, with atomic release, deterministic
429/`Retry-After`/`no-store` responses, and no mutation on rejection. The
audio-handle, audio-cache, history, and polling query boundaries preserve
URLSearchParams multiplicity and reject unknown keys, empty or duplicate
identifiers, and oversized values after decoding; focused tests verify the
standard validation error envelope. The current snapshot is 124 backend files
and 685 tests; the complete repository gate passes.

Progress (2026-08-31, four-slice RuntimeLimits/property-corpus evidence): the deterministic
limit-inventory contract now covers JSON, avatar/data URI, file transfer,
audio, STT, streaming, tool payloads, prompt/workflow, log retention, and
concurrent model requests, including owner, enforcement seam, test evidence,
and configurability classification. `RuntimeLimits` adds strict finite
environment parsing and has been migrated into the JSON-body, audio-handle,
STT, attachment, and OpenAI streaming enforcement seams. Four `RuntimeLimits`
slices now provide strict finite environment parsing with preserved defaults
across JSON/body, binary/audio/STT, streaming, tool/prompt/workflow/log, and
admission concurrency bounds, with migrated enforcement seams. The
deterministic property-style corpus exercises malformed, oversized, control,
duplicate, slow, aborted, replay, and concurrency cases. Final full-gate
evidence is 126 backend files and 691 tests.

Progress (2026-08-31, query-boundary slice; full gate passes): the SSE
`clientId` query, tools `chatId` query, and models `router` query now use strict
single-value schemas with decoded max-256 bounds and unknown-key rejection.
Duplicate values are rejected before subscriber registration, chat loading, or
model listing. Empty `chatId` preserves the catalog-only optional semantics;
models preserve the omitted-router `llamacpp` default, trim surrounding
whitespace, reject empty values, and validate the normalized router against the
registered allowlist before provider work. The existing admin ComfyUI output
query similarly rejects empty/duplicate/unknown values and bounds decoded
`filename`, `subfolder`, and `type` fields before service access. Current
evidence remains 124 backend files and 685 tests; the complete repository gate
passes.

Progress (2026-08-31, route-identifier hardening): every main API route
parameter is bounded and control-character rejected before resource access,
covering audio tokens/cache IDs, AI-card IDs, and chat, message, and
participant IDs. Admin ComfyUI workflow and prompt identifiers, service names
for prompt/queue/stats/output routes, and output query fields now reject empty,
oversized, control-character, and path-separator values consistently with 400
validation responses; focused API coverage verifies validation precedes service
lookup and upstream work.

The admin route-ID rollout now validates every remaining user, session,
checklist, prompt, API-key, model, patch, and service parameter after Hono
decoding and before admission, database, filesystem, or upstream work. Setup
section routes use an explicit allowlist, and invalid values consistently return
the validation-error envelope without leaking resource existence.

Closure (2026-08-31): IRIS-012 acceptance is complete. The four
`RuntimeLimits` slices provide strict finite environment overrides with
preserved defaults across JSON/body deadlines, binary/audio/STT, streaming,
tool/prompt/workflow/log bounds, and admission windows/capacities, with
migrated enforcement seams and rejection tests. The admin request-body audit
found no unchecked legacy JSON/admin request schemas. The machine-readable
limit inventory maps every plan-listed category to its owner, enforcement seam,
test evidence, and explicit configurability classification; the deterministic
property-style boundary corpus and final audit cover malformed, oversized,
control, duplicate, slow, aborted, replay, and concurrency cases. Distributed
quota coordination and cross-resource crash semantics remain under IRIS-013,
IRIS-032, and IRIS-062 and do not block this ticket.

Follow-up (2026-09-01): the limit-inventory test's stale expected
category/count was corrected after the RuntimeLimits and query-boundary
additions; the inventory contract now passes without weakening any
enforcement assertion.

- Define Zod schemas for params, queries, headers, and bodies; stop casting raw
  JSON to TypeScript interfaces. Return consistent 400/401/403/404/409/413/429
  responses rather than converting authorization failures to 500.
- Add configurable, conservative limits for JSON, avatar/data URI, file upload,
  file download, audio handle, STT body, streaming chunks, tool arguments and
  results, prompt/workflow size, log retention, and concurrent regenerations.
- Stream large files to bounded temporary files instead of materializing entire
  request bodies/base64 strings. Sniff/validate media content; do not trust file
  extension or `Content-Type` alone.
- Make attachment-file creation and database-message creation one recoverable
  operation. A database failure must remove the staged file, and a download
  bound must be enforced while reading rather than after a provider has loaded
  and base64-encoded the whole file.
- Add per-IP and per-account throttles for login, PIN/password changes,
  bootstrap, guest chat, uploads, model requests, service probes, and expensive
  admin operations. Respect proxy headers only through explicit trusted proxies.
- Add request IDs, deadlines, abort propagation, and cleanup on disconnect.

Acceptance: boundary/fuzz tests cover malformed JSON, NaN/negative pagination,
oversize bodies, slow streams, aborted requests, replay, and concurrency caps.

### IRIS-013: authentication and admin hardening — IN PROGRESS

Progress (2026-08-28): non-PIN credentials now require at least 12
characters, administrator password creation/reset uses the same validator,
and the last administrator cannot be demoted or deleted. Bootstrap tokens are
reserved during account creation and released on failure; remote bootstrap
errors no longer include internal exception text. Admin mutations now require
a trusted Origin when cookie-authenticated and normalize unauthenticated
requests to 403. Failed sign-ins now use a bounded SQLite limiter with
deterministic 429/reset and multi-instance contract coverage. Backend recent-auth
grants/enforcement and the accessible frontend prompt/single-retry flow are
implemented and tested. Per the LAN-first user decision, MFA enrollment and
recovery are explicitly deferred to post-v1; they must be implemented before
direct internet exposure or use by mutually untrusted users.
CSRF/session policy and broader distributed rate limiting remain open.

Resolved audit portion (2026-08-29): the limiter now uses shared SQLite state
with hashed identity keys, atomic updates, expiry cleanup, and bounded oldest-key
eviction; production initializes it after auth DB setup. Two-instance contract
coverage confirms cross-instance blocking, reset, expiry, and privacy. The limiter
uses the
adapter-provided direct peer address rather than forwarding headers, applies 5
failures/minute per source and a separate 20 failures/minute account aggregate,
omits source aggregation when trusted peer information is unavailable, resets
account state after successful authentication, and bounds/ages its state. Twelve
focused tests cover blocking, retry timing, source/account independence,
cross-source success, missing-peer behavior, expiry, reset, and SQLite contracts.
Multi-instance coordination and restart persistence are implemented; production
thresholds still require operational tuning, contention monitoring, and observability.

Progress (2026-08-31, recent-auth policy audit): the sensitive-mutation policy
is an explicit method-aware, end-anchored allowlist covering credential and
session mutations, key changes, all supported software installs, model
removal, service start/stop, patch approval/apply/rollback, and reset-defaults.
Focused tests cover positive high-risk paths, method sensitivity, nested/extra
path rejection, and the intentional exemption for model registration (which
remains admin-authenticated and strictly schema-validated). MFA enrollment and
recovery policy is deferred to post-v1 hardening under the LAN-first decision;
broader CSRF/session threat-model evidence and distributed
rate-limit operational tuning remain open.

Progress (2026-09-01, LAN origin-policy evidence): the LAN-first slice now has
an explicit origin-decision helper and a table-driven matrix for configured LAN
HTTP/HTTPS origins, optional remote origins, mismatched origins, missing Origin
on cookie-authenticated mutations, and unauthenticated bootstrap compatibility.
The recent-auth matrix assertion was corrected to exercise independent protected
and intentionally ordinary paths rather than a tautological expectation. This
does not close the broader CSRF/session threat-model work. Cookie attribute
evidence remains incomplete: the deterministic suite does not yet prove
HttpOnly/SameSite/Secure behavior across local, remote, HTTP, and HTTPS
deployment modes. Treat those attributes as an explicit product/deployment
policy and acceptance-test gap before remote exposure, not as completed evidence.

- Raise the non-PIN password minimum and define a deliberate password policy;
  do not treat four arbitrary characters as adequate. Keep PIN use local-only
  or protect it with strong rate limiting/device constraints.
- Add MFA/recent-auth checks for keys, passwords, role changes, user deletion,
  network/TLS settings, software installation, model removal, service control,
  reset, apply, and rollback.
- Prevent deletion/demotion of the last admin, not only self-demotion.
- Make bootstrap creation transactional: do not permanently consume the only
  token before user creation and admin promotion both succeed. Never echo raw
  internal exceptions to remote bootstrap clients.
- Apply trusted-origin/CSRF policy consistently to every state-changing route;
  verify SameSite/Secure cookie behavior for local, remote, HTTP, and HTTPS.
- Add session revocation and audit tests, including actor/target separation.

Acceptance: threat-model tests cover brute force, CSRF, stolen stale session,
last-admin protection, bootstrap races, and failure rollback.

### IRIS-014: runtime data, key, and path isolation — IN PROGRESS

Progress (2026-08-28): production defaults use OS application-data
directories, tests require temporary roots, and configured data roots are now
rejected when they are symbolic links. Data roots and database files now enforce
0700/0600 permissions, reject outside-root paths, and reject symlinked nested
database paths. Migration/rollback, secret storage, and separate lifecycle
roots remain open.

Progress (2026-08-29): named provider keys now use AES-256-GCM with independent
random nonces; SQLite stores only ciphertext, nonce, tag, name, and timestamp.
The 32-byte master key is supplied through `IRIS_API_KEYS_MASTER_KEY` or a
private, same-owner, non-symlink key file. Legacy plaintext rows are validated
and migrated transactionally with secure-delete/checkpoint/VACUUM cleanup;
malformed schemas, missing/wrong keys, tampering, insecure files, and UTF-8 byte
overflow fail closed. Ten focused tests cover round trips, nonce uniqueness,
plaintext absence, migration, corruption, key files, deletion, and bounds.
`DATA_LIFECYCLE.md` documents deployment, backup/recovery, and storage-media
caveats. Supported in-place master-key rotation is now available through the
non-HTTP CLI with preflight authentication, fresh nonces, transactional
verification, rollback tests, and documented backup/replacement ordering.
Rotation inputs share startup's bounded regular-file, same-owner, private-mode,
and no-symlink checks. The process must restart to reload the replacement key. OS-keyring integration and
storage-media secure erasure remain open.

Progress (2026-08-30): runtime origin configuration is validated and normalized
at startup, with the trusted-origin/CSRF boundary covered by regression tests.

Progress (2026-09-01, recovery-input review): recovery input containment now
checks symlinked parents and containment for both recovery roots. The focused
review matrix passes 8/8 cases. A residual TOCTOU risk remains in the
path-check/open sequence where descriptor-relative primitives are unavailable;
IRIS-014 therefore remains IN PROGRESS.

- Change the production default data directory from a source-tree-relative path
  to an OS-appropriate app-data location; tests must always use temporary dirs.
- Migrate with explicit confirmation, backup, atomic rename/copy verification,
  permissions (`0700` directories, `0600` sensitive files), and rollback.
- Store API keys using OS keyring/secret storage or documented encrypted storage;
  keep names/metadata in SQLite. Redact environment values and paths in logs,
  patches, errors, exports, and support bundles.
- Separate user files, databases, managed runtimes, models, caches, logs, locks,
  and temporary downloads into distinct roots with retention policies.
- Ensure foreign/pre-existing services and files are never mutated or removed.

Acceptance: clean install, migrated install, rollback, permissions, path with
spaces, symlinked data root, and read-only source-tree tests pass.

### IRIS-015: harden Tauri filesystem, docs, shell, and capabilities — IN PROGRESS

Primary files: `frontend/src-tauri/src/{filejail,docs,shell}.rs`, capability and
Tauri config, frontend tool executor.

- Canonicalize and open the configured root safely; reject a symlink root and
  prevent symlink-swap races using descriptor-relative/no-follow operations
  where supported. Make writes atomic and bounded.
- Ensure recursive docs listing/search never follows directory symlinks, caps
  depth/file count/bytes/time, skips binaries, and handles permission errors.
- Reimplement captured processes with concurrent stdout/stderr drains, bounded
  ring buffers, a real deadline, process-group/tree termination, cancellation,
  and no blocking read before timeout checks.
- Docker modes should pin an image digest and add non-root user, `--network=none`
  by default, CPU/memory/PID limits, dropped capabilities, no-new-privileges,
  read-only rootfs, and explicit writable temp space. Make exceptions visible.
- Fix PTY lifecycle: insert the writer, honor working folder/mode/approval,
  remove writers/children/masters on exit/close, cap sessions/output, and kill
  descendants. If interactive shell is unused, delete it and its commands.
- Enable a restrictive CSP. Remove unused shell/fs plugins or permissions;
  prefer custom audited commands over broad plugin access. Validate external
  URL schemes/hosts before opening.

Acceptance: adversarial tests cover symlink swaps, recursive symlink escape,
huge files/output, silent hanging commands, forked children, PTY cleanup,
container network/resource isolation, and CSP behavior.

Progress (2026-08-28): Tauri now has a restrictive CSP and a focused config
test. The main-window capability grants only Tauri core defaults, the
user-initiated dialog picker, and the shell plugin's custom-regex-constrained
HTTP(S) link opening. No filesystem plugin permission is granted; native filesystem access
continues through the audited custom commands. Recursive docs listing and
search now skip symlinked directories and files, and a native adversarial test
proves an in-root symlink cannot expose outside content. Interactive PTY
writers are now retained for writes and masters are removed on close. Native
captured commands now drain stdout/stderr concurrently and cap each captured
stream at 1 MiB, avoiding the prior blocking-read behavior and bounding the
returned buffers.
Unix timeout cleanup terminates the command process group, with native
regression tests for output bounds and silent-command deadlines. Recursive
docs structure/search now cap depth, entries, per-file bytes, and total search
bytes. Docker execution now defaults to no network, non-root numeric user,
read-only rootfs, bounded CPU/memory/PIDs, dropped capabilities, and a small
noexec temporary filesystem. Filesystem race protection, digest pinning, and
remaining PTY descendant/output lifecycle tests remain open. Managed service
processes now use dedicated POSIX process groups, and stopping an owned service
terminates its descendants; PTY session count and initial command size are also
bounded before spawning. Native file-jail writes now use a unique sibling
temporary file, sync, and atomic replacement; destination symlinks are not
followed and failed writes clean up safely.

Progress (2026-08-29): captured-output reader threads now use a bounded
backpressured channel (64 chunks) while retaining the 1 MiB per-stream result
cap; focused native tests continue to cover noisy output and silent-command
deadlines. File-jail roots that already exist as symlinks are rejected, reads
are capped at 16 MiB, and decoded/raw write inputs are capped before atomic
replacement; tests cover root symlink rejection and oversized reads/writes.
Superseded by the descriptor-relative Unix follow-up below. Digest pinning and
the remaining PTY descendant lifecycle tests remain open.

Progress (2026-08-29, PTY lifecycle): interactive output now flows through a
bounded synchronous channel (64 queued 16 KiB chunks), applying backpressure
to the PTY reader. A hard 1 MiB per-session emitted-output budget protects the
downstream webview queue as well; overflow emits explicit truncated/closed
events and terminates/cleans up the session. Interactive writes reject
payloads larger than 64 KiB. Session resources are registered before reader
threads start, preventing fast-exit cleanup races. Session close and reader
termination remove writer/master/child state; on Unix, an available PTY child
process group is killed before the child is waited. Focused tests cover the
PTY/write/event limits and output-budget helper; formatting and Clippy pass.
Remaining: descendant termination is best-effort where portable-pty cannot
expose a process id, and Docker digest pinning remains open.

Progress (2026-08-29, file-jail descriptors): Unix reads and writes now open
the configured root once, traverse every user-controlled component with
descriptor-relative `openat` plus `O_NOFOLLOW`, create missing directories via
`mkdirat`, and commit owner-only sibling temporaries with `fsync`/`renameat`.
Intermediate symlink reads/writes fail without touching outside data. Fourteen
native tests pass. Non-Unix jailed I/O remains explicitly fail-closed. A
`CreateFileW` implementation using `OPEN_REPARSE_POINT` was rejected because
it protects only the final component while intermediate reparse points may be
followed; no such code is enabled. Windows support requires an audited,
root-handle-relative native traversal API with tests before activation.
Configured-root ancestor handling and high-frequency swap stress remain
deployment-validation items.

Progress (2026-09-01, documentation-tool review): `tool_docs_read` now enforces
an 8 MiB bounded read with exact-boundary acceptance and over-boundary
rejection, covered by an independent review and focused native tests. IRIS-015
remains IN PROGRESS: Windows descriptor-safe jail traversal, Docker digest
pinning, and portable PTY descendant cleanup are still open.

### IRIS-016: service/download/SSRF safety — IN PROGRESS

Progress (2026-08-29): service endpoint validation now rejects non-HTTP(S)
URLs, embedded credentials, fragments, cloud metadata/link-local targets, and
probe redirects; service probe JSON responses are bounded at 2 MiB before
parsing. ComfyUI JSON and binary responses are bounded at 1 MiB and 10 MiB,
and output filename/subfolder values reject traversal,
absolute paths, backslashes, and control characters. Private-target policy,
DNS-rebinding controls, checksummed downloads, and foreign-process protections
remain open. The ComfyUI client now also bounds workflow depth/keys/strings,
validates request and response shapes, enforces output-type and identifier
constraints, and supports caller cancellation plus timeouts; focused tests
cover these limits. The native client now performs injectable one-shot DNS
validation, rejects unsafe resolved addresses and non-local loopback resolution,
pins default HTTP(S) connections to the validated address while preserving
Host/TLS naming, disables redirects, and bounds native response reads.
JSON endpoints enforce the 1 MiB limit inside the pinned transport using both
declared and streamed size; binary output uses the 10 MiB attachment limit.
The root `sbom:check` gate now deterministically inventories the locked pnpm
virtual store and Cargo.lock into validated SPDX 2.3 JSON in memory/temp-only,
including package identity, version, and license fields without committing an
SBOM artifact. This is inventory validation, not signing or provenance proof;
checksummed/signed distribution remains open.
The standalone `artifact-checksum.mjs` utility now creates and verifies sorted
SHA-256 manifests for explicitly supplied release files, streams file hashing,
rejects symlinks/non-regular/missing or root-escaping paths, and detects
tampered, missing, or extra entries. It is intentionally not wired into
`verify` because this workspace has no authoritative release artifact set and
it does not provide signing or provenance.
Twenty-four focused ComfyUI tests cover DNS/private-address policy, literal
local service access, pinned transport, redirect rejection, response shapes,
workflow/path validation, bounds, timeout, and cancellation behavior.

Progress (2026-08-29, shared outbound transport): a reusable transport now
validates all one-shot DNS answers, blocks private/link-local/metadata/mapped/
multicast and hostname-to-loopback targets, pins Host/SNI connections, refuses
redirect following, propagates cancellation/timeouts, and enforces declared and
streamed response limits. Model discovery, non-streaming OpenAI-compatible
completion, TTS, STT multipart upload, and DuckDuckGo search use it;
deterministic tests cover transport policy and each migrated caller. Streaming
model completion still uses the older bounded Fetch/SSE parser and needs a
pinned, backpressured streaming transport. Service probes and ComfyUI retain
equivalent specialized transports pending safe consolidation.

- Validate service endpoints by scheme and policy; block credentials in URLs,
  disallowed redirects, link-local/cloud metadata, unexpected loopback/private
  targets for remote deployments, and DNS rebinding where applicable.
- Pin downloads to approved HTTPS origins, signed/checksummed artifacts and
  versions. Use partial files, cancellation, space checks, atomic promotion,
  and ownership manifests. Never execute unverified downloads.
- Make service start locks and process identity robust across crashes/reboots;
  terminate only proven Iris-owned processes. Bound/redact logs and environment.
- Treat ComfyUI filenames/subfolders and model paths as untrusted. Validate
  workflows and response sizes before proxying.

Acceptance: SSRF, redirect, checksum failure, disk-full, cancellation, crash,
PID reuse, and foreign-service tests pass.

Resolved audit portion (2026-08-29): service probes resolve once, validate every
returned address, and pin a validated address into the actual Node HTTP(S)
request while preserving the original Host header and TLS server name. DNS
failures, RFC1918/CGNAT/link-local/metadata, IPv4-mapped IPv6, multicast, and
arbitrary hostname-to-loopback targets fail closed; literal loopback and
`localhost` remain available for local managed services. Redirects are disabled
and responses abort above 2 MiB. Thirty-two deterministic service tests pass.
Apply this centralized policy to ComfyUI/provider/model/TTS/search upstreams
before considering SSRF coverage complete.

Progress (2026-08-29): installer hardening slice implemented. Audio.cpp,
llama.cpp, and ComfyUI installations now fail closed unless an explicit
40-character commit SHA is configured, validate the approved GitHub HTTPS
origin, refuse to modify unowned directories, record an Iris ownership
manifest, fetch/check out the pinned revision detached, and terminate spawned
process groups on timeout. ComfyUI dependency installation now requires hashed
requirements. Remaining work includes signed/checksummed release artifacts,
signed/checksummed artifact distribution, disk-space checks,
transactional staging/promotion, process identity protection for service
management, and a reproducible mechanism for distributing the approved commit
SHAs. Existing installs without `.iris-managed.json` are intentionally
ineligible for in-place updates and must be migrated or reinstalled.

Follow-up (2026-08-29): deterministic helper tests cover exact ownership
metadata, hash-lock preflight, bounded logs, and AbortSignal cancellation.
Cancellation and timeout wait for child exit after terminating its process
group, with five-second SIGKILL escalation; installer subprocesses inherit only
a minimal environment. Artifact signatures/checksums remain open.

Integration follow-up (2026-08-29): ComfyUI now runs the hash-lock preflight,
existing roots are rejected unless their ownership manifest exactly matches the
approved source and revision, and all three admin install streams pass the raw
request AbortSignal through to the installer subprocesses. NDJSON response
semantics are unchanged.

Progress (2026-09-01, installer path review): installer path validation now
rejects both final and nested symlink components; review found and fixed a
parent-component bypass, with 9/9 focused cases passing. Residual path-check
TOCTOU exposure and native Windows junction/reparse-point CI evidence remain,
so IRIS-016 stays IN PROGRESS.

## 6. Phase 2 — repository and test hygiene

### IRIS-020: one workspace, one lockfile, explicit test roots — COMPLETE

- Keep the root `pnpm-workspace.yaml` and root lockfile; remove nested backend
  and frontend lock/workspace files after confirming no standalone workflow
  depends on them.
- Add backend/frontend Vitest configs with `include: ["tests/**/*.test.ts"]`
  and explicit excludes for `data`, `.venv`, `node_modules`, `dist`, `target`,
  managed software, models, caches, and external repositories.
- Separate unit, integration, live-network, hardware, destructive, and packaging
  projects. Live tests must be opt-in and must not silently pass as coverage.
- Prevent test imports from using the production/default data directory; fail
  fast unless a test temp root is present.

Acceptance: `pnpm test` runs only first-party backend/frontend tests, with zero
discovered third-party tests or production data writes; current verification is
244 backend tests in 42 files and 53 frontend tests in 8 files.

### IRIS-021: ignores and artifact removal — COMPLETE

After IRIS-000/001/014:

- Add a root ignore policy for dependency stores, `dist`, `target`, coverage,
  logs, temp files, SQLite DB/WAL/SHM, locks, caches, local settings, secrets,
  virtualenvs, downloaded software, and models.
- Remove tracked generated/dependency/runtime artifacts using Git-aware removal,
  never raw bulk deletion. Preserve lockfiles and intentional small fixtures.
- Remove stale build output in backend/frontend and the Rust target tree; prove
  clean builds recreate only ignored outputs.
- Decide whether `external/audio-cpp-service` is a submodule, package, fetched
  dependency, or documentation pointer; give it one clear lifecycle.

Acceptance: the workspace contains no user/runtime state and build/test leaves
the non-destructive clean-output check passing. Git-status verification is not
applicable in this non-Git snapshot; the tracked-removal clause is therefore
not applicable.

Audit history (2026-08-29): `pnpm verify` recreated three generated
directories that the original clean check rejected. The invariant is now
explicitly “known build outputs are permitted and unexpected artifacts fail.”

Progress (2026-08-29): `clean:check` now skips directory symlinks, preventing
cleanup verification from traversing outside the workspace. Regression
coverage confirms linked external build output is not reported.

### IRIS-022: quality gates — PARTIALLY COMPLETE

Progress (2026-08-31): local workflow, audit, coverage, and update-policy
implementation is complete; hosted execution evidence remains the only open
scope for this ticket.

- Add ESLint with TypeScript/Svelte rules, Prettier (or a documented equivalent),
  no-unused checks, import ordering, promise/cancellation rules, and bans on
  production `any`, unsafe assertions, floating promises, and giant lines.
- Format minified admin/control-plane files in formatting-only PRs before logic
  refactors. Preserve behavior and snapshot test public schemas.
- Add `cargo fmt --check`, `cargo clippy --all-targets --all-features -D warnings`,
  Rust tests, dependency/license audit, TypeScript checks, Svelte checks, unit
  tests, and build jobs to CI.
- Add coverage thresholds by critical module, not a single easily-gamed global
  number. Security policy and migration branches require high branch coverage.
- Add secret scanning and dependency update policy; review rather than blindly
  applying major upgrades.

Acceptance: one root `pnpm verify` (plus documented platform jobs) is deterministic

Implemented in the current snapshot:

- `pnpm verify` composes TypeScript/Svelte checks, unused-symbol enforcement,
  first-party tests, builds, and native Rust formatting, Clippy, and test gates.
- Backend TypeScript enables `noUnusedLocals` and `noUnusedParameters`; existing
  violations were removed without changing runtime behavior.
- Native Rust sources are formatted with `cargo fmt`; `cargo clippy
--all-targets --all-features -- -D warnings` is the warning-free native gate.

Implemented: the locked Prettier toolchain, repository format gate, unused checks,
critical coverage gate, dependency/license and secret scanners, a least-
privilege Linux CI workflow, and monthly grouped Dependabot updates for npm and
Cargo with bounded open PRs and no auto-merge. `pnpm verify` is deterministic in
this snapshot; the network-backed `pnpm audit:high` remains a scheduled/manual
check outside that gate.
hosted CI evidence, broader coverage thresholds, vulnerability/update policy,
and platform jobs remain. A no-dependency `test:critical` command also runs the
pinned-HTTP, auth, JSON-limit, refresh, and attachment security suites.
The gate currently covers six existing suites (pinned HTTP, auth, JSON limits,
attachment signatures/flows, and OpenAI compatibility usage limits).

## 7. Phase 3 — backend decomposition and correctness

### IRIS-030: split the API by domain — COMPLETE

Audit (2026-08-30): the current public API composition has no pure health/version
route. Its smallest apparent candidates (`/models`, `/model-routers`, and
`/setup-info`) still depend on authenticated viewer resolution, setup/database
state, or model-router initialization. A trial extraction caused module-load
and transaction regressions and was reverted; the next safe seam requires an
explicit route-factory dependency boundary (or a new pure health route) before
moving handlers.

Progress (2026-08-28): removed the duplicate BetterAuth wildcard route
registration from the backend entrypoint. The route contract remains covered;
domain route extraction and centralized middleware remain open.

Progress (2026-09-01): polling messages/chats are extracted into
`backend/src/api/polling-routes.ts` behind an injectable route factory. Auth,
query parsing, chat authorization, readable-message filtering, response shape,
and fail-closed error handling preserve prior API behavior; focused route tests
cover ordering and authorization-before-read parity. Broader API decomposition
and middleware consolidation remain in progress.

Progress (2026-09-01, model/setup route slice): read-only `/models`,
`/model-routers`, and `/setup-info` are extracted into
`backend/src/api/model-routes.ts` behind injected authentication, query,
catalog, setup, and error-response dependencies. Focused route tests verify
authentication and model-router validation ordering, setup response parity,
and fail-closed errors; the remaining API decomposition and middleware
consolidation remain in progress.

Progress (2026-09-01, audio-handle route slice): ephemeral audio fetch and
upload-handle routes are extracted into
`backend/src/api/audio-handle-routes.ts` behind injected authentication,
query/token parsing, chat authorization, bounded-body, MIME validation, and
transient-storage dependencies. Focused tests cover authorization-before-body
reads, missing/expired tokens, no-store binary replay, response shape, and
production parity; API integration and audio-handle suites remain green.
Polling and audio-handle extraction advance the route-module boundary, while
model/setup extraction now advances it further; chat/history, stream, cards,
tools, and shared middleware decomposition remain open.

Progress (2026-09-01, AI-card/chat-read/message-mutation route slices):
registered-user AI card CRUD, chat history/participant reads, and message
rewrite/following-delete mutations are extracted into
`backend/src/api/ai-card-routes.ts`, `backend/src/api/chat-read-routes.ts`, and
`backend/src/api/message-mutation-routes.ts`. Focused module and integration
tests preserve authentication → route-ID → membership ordering, strict
schemas, propagation, response shapes, authorization-before-read parity, and
the delete mutation's best-effort `truncated` event. Deletion now anchors its
database reference to the target chat and invalidates active generation
history before mutation, preventing cross-chat deletion and stale writes. The
stream route is now
also behind `backend/src/api/stream-routes.ts`; its cleanup closes the queue,
unsubscribes exactly once, unregisters the SSE owner, and removes only the
disconnecting client's tool configuration. Focused and live HTTP SSE tests
cover disconnect cleanup and recipient isolation. Remaining chat creation,
send/stop, compaction, guest/context, participant/settings, shared middleware,
and broader API decomposition remain in progress.

Progress (2026-09-01, compaction route slice): progress and explicit AI
compaction endpoints are extracted into
`backend/src/api/compaction-routes.ts` with injected authentication, strict
chat/participant IDs, membership checks, participant-role validation, lazy
compaction operations, and standard error handling. Focused route, cursor,
service, and integration tests preserve response parity and fail closed for
missing or non-AI participants.

Progress (2026-09-01, stop and chat-creation route slices): explicit stop
generation is extracted into `backend/src/api/stop-routes.ts` with injected
authentication, route-ID parsing, membership, chat control, body parsing, and
error handling; focused tests preserve authorization-before-body and targeted
or all-participant stop semantics. Chat creation is extracted into
`backend/src/api/chat-creation-service.ts` with exported/injected schemas and
normalization: the authenticated creator is canonical and first, human names
resolve server-side with duplicate-human removal, AI routers/models/context and
default API-key values come from setup/router dependencies, and the existing
atomic `createChat`/post-commit instance-cache owner remains authoritative.
Unknown settings are stripped for compatibility while recognized settings are
typed; module, API integration, and atomic/failure suites pass (154 backend
files, 812 tests in the last full gate; a post-slice full rerun remains
pending). Remaining guest/context, shared middleware, and broader API
decomposition remain in progress.

The same chat-creation slice now uses the shared
`backend/src/api/message-recipient-resolver.ts` boundary for explicit and
mention-derived recipients, preserving caller order while deduplicating join
targets and rejecting unknown participant IDs before model admission. Guest
message history pruning remains behind the injected `scheduleGuestHygiene`
operation, so retention side effects stay conditional on the current
`guest_chat_id` and do not become part of message persistence. These changes
have focused API, recipient, guest, and atomicity evidence.

The final message route is now extracted behind
`backend/src/api/message-routes.ts`, with injected recipient resolution,
guest hygiene, model-admission reservation, chat dispatch, and error/rate-limit
dependencies. It preserves the two membership checks, reserves exactly one
lease per resolved AI target, and releases leases through persistence,
schedule, interruption, and restart paths. Route tests cover ordering,
recipient/deduplication behavior, admission contention and cleanup, and
response parity. All chat-facing API endpoints are now composed through route
modules; no inline chat API handlers remain. IRIS-030 remains in progress for
shared middleware/helper ownership and wider composition cleanup. The latest
full gate passes with 166 backend files/861 tests, 24 frontend files/129 tests,
and 25 Rust tests.

The API composition layer now also delegates request logging/correlation to
`backend/src/api/api-middleware.ts`; stream/readability authorization helpers
remain explicit injected boundaries, and mutable audio replay regeneration is
owned by the per-service `createAudioCachePlaybackService` factory in
`backend/src/api/audio-cache-service.ts` rather than a module-level route map.
Focused middleware, stream, readability, audio-cache, and replay tests pass.
The latest full gate remains 166 backend files/861 tests, 24 frontend files/129
tests, and 25 Rust tests; the post-extraction backend rerun is historical and
is superseded by this complete gate.

Closure audit (2026-09-01): `backend/src/api/api.ts` is reduced to 381 lines
of composition, with inline route handlers removed. Route and schema ownership
now resides with domain modules, while shared route-ID/query validation,
middleware, auth guards, readability, admission, recipient resolution, guest
hygiene, and audio replay each have explicit leaf/factory boundaries. Direct
route-module tests cover 16 files/50 tests, and mutation/read schema
cross-reviews found no strictness, default, error-envelope, dynamic-descriptor,
or import-cycle drift. IRIS-030 is complete; remaining API work is outside
this ticket's composition-only acceptance.

Progress (2026-09-01, tool-control/participant/audio-cache/chat-lifecycle
route slices): frontend-tool configuration and response controls are extracted
behind `backend/src/api/tool-control-routes.ts`, with member-before-body
ordering, exact user/client ownership checks, bounded registry capacity,
loaded-group and prompt-override updates, and deterministic late/expired
response rejection. Participant management is extracted behind
`backend/src/api/participant-routes.ts` with strict human/AI defaults,
authorization-before-body parsing, cache eviction after settings mutation, and
validation envelopes for missing or unknown users. Private audio-cache replay
is extracted behind `backend/src/api/audio-cache-routes.ts`; chat confinement,
disabled-cache behavior, bounded regeneration, private MIME responses, and
tampered persisted MIME rejection are covered. Context clear, guest singleton
rename/delete protection, best-effort deletion notifications, and delete then
evict ordering are extracted behind `backend/src/api/chat-lifecycle-routes.ts`.
Guest singleton creation remains transactional, while provider projection
trust validation, injected fault handling, and concurrent singleton recovery
are covered by existing focused evidence. Shared middleware/helper ownership
and broader composition cleanup remain in progress.

Break `backend/src/api/api.ts` into route modules for session/viewer, chats,
messages/history, participants, cards, tools, audio, models/setup, and polling.
Use shared middleware for schemas, authorization, limits, errors, and request
context. Remove the duplicate BetterAuth route registration in `index.ts` and
test the documented Hono trie workaround once, centrally.

Acceptance: route contract tests remain green; no route module exceeds the
agreed size/complexity threshold; the route-policy matrix is generated/tested.

### IRIS-031: separate chat orchestration responsibilities — COMPLETE

Split `chat/chat.ts` into message service, generation coordinator, tool-loop
executor, reply router, interrupt/cancellation controller, live event broker,
and instance cache. Replace mutable cross-cutting sets/maps with explicit
per-generation state and guaranteed cleanup. Eliminate dead code such as the
currently unused `nativeAudioInput` path unless a tested producer is added.

Acceptance: race tests cover simultaneous sends, stop during setup/tool calls,
history rewrite during generation, disconnect, timeout, and multiple AIs. The
bounded extraction and lifecycle seams satisfy this acceptance; broader
cross-product production-readiness work is tracked by the applicable tickets.

Progress (2026-08-31): the bounded `GenerationCoordinator` now owns one
generation per AI, distinguishes restartable interrupts from explicit stops,
and cleans up abort state deterministically. Frontend-tool waits observe the
generation signal; stop/rewrite cancellation removes pending requests, rejects
late responses, and prevents stale tool-result persistence. Focused tests cover
duplicate generation suppression, multi-AI ownership, stop precedence, stream
stop, timeout, stop/rewrite during frontend waits, and cleanup.

Progress (2026-08-31): generation observability now classifies an aborted
normal-resolution path as cancelled rather than completed, with the cancelled
counter and active gauge balanced exactly once. Focused cancellation and
counter/gauge tests cover synchronous throws, asynchronous rejection, abort,
and normal completion without double counting.

Progress (2026-08-31): reply routing and the live event broker now have explicit
extracted seams while preserving the public `ChatInstance` behavior. Focused
tests cover recipient-scoped routing, buffered replay, lifecycle events,
subscriber isolation, and broker cleanup.

Progress (2026-08-31): message persistence, publication, and AI scheduling now
have an explicit `MessageService` seam with persist-before-publish-before-
schedule ordering. Focused tests cover silent sends, recipient filtering,
persist/publish/schedule failure behavior, synchronous and asynchronous
scheduling-failure containment, and preservation of the existing public send
contract.

Progress (2026-08-31, latest): tool-loop execution is separated behind its
validated executor seam, and instance disposal now cancels active generations
and pending frontend-tool waits before clearing subscribers. Eviction,
`clearContext`, and global shutdown reject stale writes and prevent post-disposal
restarts. The module cache now has in-flight construction ownership via
`pendingInstances`, so concurrent `getChat` calls share one instance and failed
loads are cleaned up for retry. The unused `nativeAudioInput` path has been
removed. The cache now has a bounded idle-only LRU policy with an explicit
activity predicate covering subscribers, active generations, pending tool
waits, in-flight construction, and disposal; runtime-limit configuration and
replacement/clear/shutdown protections are covered by focused race tests.

The instance-cache module now owns in-flight construction, reuse after
clear/evict, failed-load cleanup, and idempotent disposal. Cross-review race
coverage verifies simultaneous sends, cancellation during setup and frontend
tool waits, client unsubscribe/disconnect during generation, late wait
resolution, event-broker clearing, shutdown ordering, and prevention of
post-disposal scheduled work. The tool-loop executor, strict descriptor/schema
boundaries, and native-audio dead-code deletion are covered by the related
focused suites. The bounded idle-only eviction policy is now implemented.

Additional progress (2026-08-31, instance-cache cross-review): replacement of
an owned instance now disposes the previous value; eviction during async
construction disposes the stale result instead of leaking or resurrecting it;
and global disposal clears cached and pending ownership so disposed instances
cannot be returned after shutdown. Focused lifecycle and cache race tests
cover these cases.

Progress (2026-09-01, SSE push-queue review): the live event broker's
`PushQueue` now defaults to 256 pending entries; the 257th entry closes,
wakes, and rejects the queue. Direct delivery, subscriber cleanup, and the
six focused queue tests were independently reviewed. `didOverflow` telemetry
is not yet wired, so this is recorded as bounded lifecycle evidence rather
than new completion scope.

Progress (2026-09-01, overflow telemetry review): the bounded SSE queue emits
the fixed metric key `sse.queue_overflows` exactly once per overflow, with no
labels or payload-derived values. Eleven focused review tests cover overflow,
wake/reject, cleanup, and metric isolation. This evidence supports the
IRIS-031 lifecycle and IRIS-060 metrics contracts; broader observability
documentation remains subject to the ticket's existing status.

Additional progress (2026-08-31, model admission): generation admission now
atomically reserves all selected AI targets per authenticated account and
trusted adapter source. Idempotent leases release on persistence failure,
synchronous or asynchronous scheduling failure, abort, stop, disposal, and
completion; interrupt restarts transfer the reservation rather than bypassing
the guard. Active leases do not expire while a generation is running, and
silent/no-target messages are not charged. Focused race, API, and admission
tests cover these lifecycle paths.

Additional progress (2026-08-31, frontend-tool wait extraction):
`FrontendToolWaitRegistry` now owns exact user/client authorization, one-shot
resolution, timeout and abort cleanup, cancellation during stop/rewrite/
disposal, and balanced active/completed/cancelled/timeout metrics. Late or
wrong-client responses are rejected, and timeout observability hooks are
failure-isolated so a throwing logger cannot strand the tool-loop promise.
Focused registry and chat tests cover timeout, abort precedence, concurrent
wait cleanup, late responses, stop/rewrite cancellation, and observability
failure containment.

Additional progress (2026-08-31, compaction extraction and cache hardening):
`CompactionService` now owns measured-token versus progress fallback,
threshold-boundary policy, callback ordering, and failure isolation while
preserving the prior `ChatInstance` behavior; focused tests cover zero and
undefined token measurements, exact thresholds, bounded summary construction,
redacted failures, and diagnostic-sink failures. `InstanceCache` now enforces
the bounded idle-only LRU policy through an explicit activity predicate and
runtime-limit configuration, with race/configuration protection across
replacement, clear, eviction, construction failure, and shutdown. Focused
cross-review tests cover stale references, disposal, concurrent construction,
and lifecycle cleanup.

Additional progress (2026-09-01, generation context and frontend-tool
configuration ownership): `GenerationContext` now owns the bounded context
assembly seam used by chat generation while preserving existing prompt and
tool behavior. `FrontendToolConfigRegistry` now owns ephemeral per-client
frontend-tool advertisements, deterministic sorted snapshots and prompt
override precedence, bounded capacity via `IRIS_CHAT_TOOL_CONFIG_ENTRIES`,
replacement-at-capacity semantics, disposal clearing, and structurally encoded
identity keys that prevent user/client separator collisions. Chat cache-idle
eligibility includes active frontend advertisements, and registry/cache,
phase1, lifecycle, provider-contract, and runtime-limit tests pass.
`GenerationStream` now owns bounded packet buffering, usage capture, tool-call
fragment assembly, eight-call iteration caps, and abort-aware cleanup while
preserving packet order and payloads. Live multi-AI SSE integration evidence verifies two authenticated
connections become active together, recipient-scoped final delivery, and
suppression of raw pre-routing partial chunks. Generation tool-context
extraction preserves the existing `iris-loop-<participant>-<iteration>-<index>`
IDs and immutable provider-native call/result order; duplicate calls now use
occurrence indexes rather than value lookup.

Additional progress (2026-09-01, generation service/finalization extraction):
`GenerationService` now physically owns the remaining generation-loop
orchestration and `generation-finalizer` owns final reply normalization and
publication preparation; the obsolete 161-line inline implementation was
removed from `chat.ts`, reducing it to approximately 796 lines while keeping
the public `ChatInstance` methods compatible. Focused finalizer, generation,
tool, and lifecycle tests remain green. A test-only real Node HTTP harness now
binds a local server, opens two authenticated SSE sockets, destroys one socket
while two AI generations are deferred, then verifies the surviving subscriber
receives the result and both AI ownership records drain. The explicit
interrupt/cancellation-controller boundary and pre-abort rewrite/dispose/stop
semantics are covered by focused tests. The latest full gate is 138 backend
files/752 tests and 24 frontend files/129 tests.

Additional progress (2026-09-01, generation audio and tool-result boundary):
`GenerationAudioHandler` now validates canonical base64, bounded decoded bytes,
and normalized `audio/*` MIME values through the shared provider contract;
generated readiness events carry explicit recipient scope, and transient
playback tokens are discarded if event delivery fails. Audio cache/transient
storage verifies actual versus recorded size, runtime/aggregate bounds,
tamper and compensation behavior, eviction ordering, and replay ownership.
Generation tool-result extraction preserves bounded provider-native call/result
order and duplicate-call IDs. Focused tests cover malformed audio, MIME and
base64 rejection, scope-safe readiness, cache/transient cleanup, and replay.
Final full verification is 138 backend files/752 tests and 24 frontend
files/129 tests.

### IRIS-032: database repositories and transactions — COMPLETE

Progress (2026-08-28): message sequence allocation, message insertion, and
recipient routing metadata now commit in one SQLite transaction. A concurrent
write regression test verifies 20 simultaneous inserts receive unique ordered
sequences. Chat creation and the remaining multi-table operations still need
transactional repository boundaries.

Progress (2026-08-29): attachment upload uses exclusive creation so it cannot
overwrite a prior file, then compensates ordinary message-persistence failures
by deleting the newly created file. Download reads stop at the configured bound
inside the provider rather than materializing an arbitrary whole file first.
Seven focused tests cover successful upload/download, input bounds, oversized
on-disk reads, persistence failure cleanup, and preservation of an existing
file. Durable staging binds the exact chat and storage path before creation;
startup reconciliation preserves committed messages, removes proven orphans,
retries failed deletion, and ignores malformed or cross-chat records.
Cross-resource atomicity remains an explicit limitation.

Progress (2026-08-30): participant and AI-participant paired inserts now use a
synchronous repository transaction with a real constraint-failure rollback
fixture. The operation leaves neither row when the paired insert fails.

Closure (2026-08-31): the verified transaction slices cover ordered message
sequence allocation, participant pairing, chat creation, attachment/message
persistence, and failure/concurrency rollback behavior. The remaining
repository decomposition is non-blocking refactoring follow-up; the accepted
atomicity and consistency boundaries are covered by tests.

- Split `chat/database.ts` into migration, chat, participant, message, settings,
  card, and metadata repositories.
- Replace N+1 participant subtype reads with joins/batched queries.
- Make chat creation, participant insertion, message+recipient insertion,
  attachment+message creation, branch rewrite, card propagation, config apply,
  bootstrap user creation, and destructive operations transactional.
- Allocate per-chat message sequence numbers safely under concurrency; add a
  unique `(chat_id, seq)` constraint after repairing duplicates.
- Remove circular dynamic imports used for cache eviction by defining explicit
  service boundaries/events.

Acceptance: failure-injection and concurrent-write tests show no partial rows,
duplicate sequence numbers, orphan attachments, or stale instances.

### IRIS-033: versioned migrations — COMPLETE

Progress (2026-08-28): chat startup now creates and consults a
`chat_schema_migrations` table, records the existing compatibility migration
as version 1, and runs that step transactionally so failed attempts leave no
completion record and retry on the next startup. Additional historical schema
coverage now includes an oldest-supported-schema fixture, data/version
preservation, idempotent rerun, and injected-failure rollback/retry checks.
Additional historical schema steps and cross-database migration coverage remain.

Additional progress (2026-08-30): the admin bootstrap store now has a
version-1 migration ledger with idempotent initialization, preservation, and
fresh-database failure rollback coverage. Auxiliary admin schema families
remain separately owned; `admin_models` now also has a version-1 ledger with
idempotent, preservation, and failure-rollback coverage. Comfy-workflow and
TTS playback families are not claimed as ledger-complete.

The migration status inspector now reports all nine application-owned ledger
families and their version/status fixtures. Status/dry-run CLI checks, operator
rollback/restore documentation, historical chat and API-key fixtures, and the
offline legacy rollback/restore drill now satisfy the ticket acceptance.

The chat migration logic now runs through an explicit-connection module rather
than an unextractable startup closure; migration extraction and status/CLI
fixtures pass. Recovery pair discovery is covered for root confinement,
symlink rejection, handle-close cleanup, and an offline legacy rollback/restore
drill with an injectable migration fault hook.

The migration CLI now supports status and dry-run inspection without applying
changes; CLI fixtures cover clean status, pending work, and invalid arguments.
This improves operator visibility and supports the offline rollback drill; an
operator-facing restore runbook and one historical API-key fixture remain.

- Replace column-presence conditionals and cross-database repair embedded in
  startup with ordered, recorded, idempotent migrations for every database.
- Back up before destructive migrations; run integrity and foreign-key checks;
  support dry-run/status and tested rollback/restore instructions.
- Consolidate schema ownership: Drizzle declarations and migration SQL must not
  silently disagree. Decide whether the long-obsolete `will_reply_prompt` and
  compatibility names are migrated away, then remove them deliberately.

Acceptance: fixtures from each supported historical schema migrate to the same
current schema/data; interrupted migration resumes safely.

### IRIS-034: typed provider and model interfaces — COMPLETE

Progress (2026-08-28): removed an unsafe participant `any` cast from model
router key/base-URL resolution and added a focused provider-profile regression
test. Audio-cache replay now validates the provider result with a runtime
schema instead of `useProvider<any>`. Generic provider interfaces, response
schemas, and stream normalization remain open. The OpenAI-compatible stream
boundary now has bounded response size/line parsing and cancellation tests;
full provider contract normalization remains open. Model-list responses now
pass through a bounded runtime guard shared by generic OpenAI-compatible and
llama.cpp routers: only non-empty printable IDs up to 512 characters cross the
boundary, with malformed entries ignored fail-closed. Regression coverage
includes provider/model punctuation and malformed remote entries.
The high-use attachment download boundary now validates the `files/read_file`
provider result at runtime (base64 content plus exact encoding) before decoding;
malformed provider output becomes a bounded validation error, with focused
valid/malformed regression coverage.
Non-streaming OpenAI-compatible completions now validate choices, message
content/reasoning, tool calls, and usage before entering chat state; malformed
responses fail with a bounded provider error. Focused valid/malformed coverage
is included.
Reasoning normalization now treats the explicit `reasoning_content` field as
the sole supported hidden-reasoning channel. Literal, split, malformed, and
unterminated `<think>` markers remain visible content, with contract coverage;
no provider-wide hidden-reasoning support is claimed.
The DuckDuckGo search provider now validates parsed remote links as HTTP(S),
drops malformed/non-web URLs, and bounds title/snippet/URL fields before
returning results. Regression coverage exercises malformed links and oversized
remote fields.

- Remove generic `useProvider<any>` and untyped records at trust boundaries.
  Give each functionality an input/output schema and runtime validation.
- Separate internal provider activation from AI-callable and human-callable
  capabilities in types, storage, API, and UI.
- Normalize OpenAI-compatible streaming/tool/usage parsing in one adapter;
  handle malformed/truncated SSE, timeouts, backpressure, retries, and explicit
  reasoning segments including literal `<think>` compatibility.
- Replace regex HTML scraping in search with a supported provider/parser or
  clearly mark the current implementation experimental and bounded.

Acceptance: contract tests can swap provider implementations without casts;
malformed remote responses fail closed with useful redacted errors.

Closure (2026-08-31): 28 concrete provider contracts contain no `z.unknown`,
with 56+ valid/malformed fixtures. Descriptor validation, typed invocation and
source guards, provider swaps, versioned stream events, malformed/truncated/
timeout/abort handling, manual iterator cancellation, response-body leak
removal, reasoning bounds, and search bounds satisfy IRIS-034 acceptance.

Additional progress (2026-08-30): llama.cpp model-list metadata now has a
bounded runtime schema and deterministic 256-entry cap; OpenAI-compatible
stream chunks enforce finite usage, bounded finish reasons, and bounded
content/reasoning deltas. Focused valid, malformed, oversized, and fail-closed
tests pass. Full provider-wide typed contracts and stream normalization remain.

Additional progress (2026-08-30): a shared provider contract registry is now
consumed by the file-read and TTS/audio-replay call sites. Strict bounded audio
and provider-swap contract tests cover valid and malformed results. Broader
provider functionality typing and stream normalization remain open.

Additional progress (2026-08-30): the model catalog registry is consumed by
OpenAI-compatible and llama.cpp routers. Generic tool arguments now use a Zod
record contract with 64 KiB, depth-16, 1,024-field, and prototype-key defenses;
focused malformed/oversized/provider-swap tests pass. Broader per-functionality
result contracts and provider-wide stream normalization remain open.

### IRIS-035: configuration ownership — COMPLETE

Progress (2026-08-30): security-sensitive public URL and trusted-origin
configuration now flows through one typed immutable runtime-config module.
HTTP(S) origins are normalized/deduplicated, constrained LAN wildcard patterns
are validated, invalid trusted entries are dropped fail-closed, and invalid
public URLs produce a non-secret startup error. Environment overrides remain
distinct from setup-file fallback values and have focused contract coverage.
Server bind host/port overrides (`IRIS_HOST`/`IRIS_PORT`) now use the same
validated immutable config boundary, rejecting malformed or out-of-range
values before listener startup.
The guest-chat retention limit (`IRIS_GUEST_CHAT_KEEP`) now follows the same
typed boundary with bounded integer parsing and focused override/rejection
coverage. Guest AI name/model overrides now use the same non-secret bounded
configuration family; model validation preserves the unconfigured setup fallback
and the `default`/provider-defined ID conventions while rejecting explicit empty,
control-character, and pathologically long overrides. The backend suite now
passes 73 files/377 tests. Remaining environment families are intentionally deferred until
their ownership and secret-handling contracts are isolated. Closure audit
(2026-08-30) classified every remaining backend `process.env` read: data-root
and platform data-directory selection, Vitest guard, interactive editor,
secret/master-key/bootstrap-token inputs, PATH/model discovery, inherited child
process variables, managed software revisions, and logging-local controls are
all intentionally local owners. Model-service base URL overrides now belong to
this runtime-config module. No unjustifiably scattered non-secret runtime
configuration remains in the audited backend source.
Authoritative ownership map: setup/settings owns persisted defaults and named
provider profiles; `config/runtime.ts` projects validated non-secret bind,
origin, guest, and default provider settings from setup plus environment
overrides; `model-manager.ts` resolves named admin profiles through the shared
projection; frontend-local settings remain frontend-owned; API keys, master
keys, and bootstrap tokens remain secret/bootstrap-owned and never enter the
runtime projection. Startup and admin-edit convergence tests cover this map.
Admin probe failure is covered as a no-drift case, and runtime apply now
restores the prior setup projection if reconciliation or the admin-state commit
fails after persistence begins.
Snapshots now use a versioned envelope carrying both prior admin config and
prior setup settings. Rollback accepts legacy config-only snapshots, restores
setup state, and reconciles the live kernel projection before changing patch
status or writing rollback audit. A failed reconciliation leaves the applied
admin state/status intact.
Closure audit inventory: `applyPatch` snapshots admin state, writes the setup
server/default-model projection, reconciles kernel provider tool config, commits
admin state/version, marks the patch applied, then writes the applied audit
entry. `rollback` currently restores only the admin-state snapshot; setup and
live kernel projections are not journaled/restored as one transaction. Failure
injection coverage exists for probe-before-apply and runtime apply restoration,
but not every commit boundary or rollback projection. These are the remaining
IRIS-035 blockers; the ticket must not be marked complete until a durable
reconciliation journal covers them. Environment projections remain immutable
and restart-scoped by design.
The acceptance is complete: the authoritative projections and durable
reconciliation state machine preserve coherent state across all commit
boundaries.

Additional progress (2026-08-31): nine authoritative real production
apply/rollback boundary cases use non-empty provider projections and assert
phase, admin version/config, patch status, intended providers, audit truth,
recovery, and idempotence. Terminal exclusions, mutex-concurrent approved
apply single-winner behavior, stale rollback no-drift, the canonical
independent-process drill, and compiled backend ready-to-SIGTERM/restart and
recovery-failure-before-listen drills all pass.

Historical progress (2026-08-30): apply and rollback now write a durable,
phase-tracked reconciliation journal containing prior/applied admin and setup
state plus the intended provider projection. Startup replays incomplete entries
idempotently before normal kernel projection and fails closed on recovery error;
focused journal, ordering, and failure tests pass. IRIS-035 remains in progress
solely because this sandbox cannot provide real process termination/restart
evidence (child-process execution is rejected with EPERM).

The recovery core is injectable; its phase-aware roll-forward/rollback state
machine and explicit terminal exclusions are covered by a 9-phase plus
4-terminal matrix. The independent-process phase drill and actual server
restart/failure drills close the former process-boundary evidence gap.

- Define one authoritative configuration model and explicit projections for
  bootstrap settings, admin config, provider config, frontend-local config,
  environment overrides, and secrets. Remove two-way synchronization that can
  silently diverge.
- Apply config through validate -> probe/test -> approve -> atomic commit ->
  reconcile runtime -> rollback-on-failure. Persist audit outcome for every step.
- Keep recovery CLI minimal; migrate ordinary CLI mutations to authenticated
  API clients as already planned in the roadmap.

Acceptance: restart, failed runtime reconciliation, stale patch, concurrent
admin, and rollback tests preserve one coherent version.

## 8. Phase 4 — frontend decomposition and product quality

### IRIS-040: split application state by domain — IN PROGRESS

Break `state.svelte.ts` into session/backend health, chat list, active-chat
history, participants/settings, live generation/SSE, tool requests, cards,
audio playback, and UI preference stores/services. Keep a small facade only if
it improves component ergonomics.

- Give every `openChat`/refresh request a generation token or AbortController so
  late responses cannot overwrite the newly selected chat.
- Clear identity, admin flag, pending tool requests, audio, streams, and private
  state reliably on logout/backend change.
- Separate server truth from optimistic UI and use one dedupe/order policy for
  polling, pages, SSE, rewrite, and reconnect.

Acceptance: deterministic tests cover rapid chat switching, logout mid-request,
reconnect duplication, late responses, branch rewrite, and stale tool prompts.

Progress (2026-08-28): the frontend state facade now guards open-chat, chat
refresh, and AI-card refresh responses against stale generations. Logout clears
streams, audio, pending tool requests, identity, and private chat state without
triggering post-logout repopulation. Three focused race/cleanup tests pass;
full domain-store decomposition and event deduplication remain.

Additional progress (2026-08-28): compaction refresh responses now carry the
same generation/logout guard as chat and card refreshes, preventing a late
response from repopulating state after a chat switch or logout.

### IRIS-041: typed API client and event protocol — COMPLETE

Progress (2026-08-28): the frontend now validates untrusted SSE payloads with
a discriminated `parseChatEvent` boundary and safely drops unknown or malformed
events. Focused event fixtures cover message, stream, tool-request, and invalid
payloads; subsequent work closed the applicable shared-schema and typed-client
acceptance criteria.

Additional progress (2026-08-28): frontend event parsing now rejects negative,
fractional, `NaN`, and infinite `branch_rewritten.deletedFollowing` values;
regression coverage includes the valid zero case; the frontend suite now passes
46 tests. The backend suite now passes 207 tests, including route-policy,
stream-limit, auth-limiter, data-root, migration, and service-lifecycle
regressions; frontend checks, Rust checks/tests, and workspace builds also pass.

Additional progress (2026-08-28): `pollMessages()` now validates every returned
message at the frontend network boundary and rejects malformed arrays instead of
letting invalid server data enter application state. The frontend API tests now
cover valid and malformed polling responses.

Additional progress (2026-08-30): `createChat()` now validates its required
chat id and preserves server error messages in focused tests. `getSetupInfo()`,
`listModelRouters()`,
`listModels()`, `listAiCards()`, chat history pages, guest-chat responses, and
chat-settings mutations now validate responses at the typed API boundary, with
success and malformed-response fixtures. The tool catalog now also validates
its stable JSON response and falls back safely on malformed or failed server
responses, with focused coverage. The frontend suite passes 104 tests in 19
files; the applicable stable JSON API surface is consolidated. An audit of remaining raw
boundaries leaves SSE streams, binary downloads, vendor/tool URL requests, and
generic admin bootstrap/control-plane requests as documented exceptions; IRIS-041
acceptance covers the remaining applicable boundaries; the listed streaming,
binary, and vendor exceptions are intentional.

Additional progress (2026-08-30): participant list/create and message-edit
responses now use strict-compatible runtime guards for required identity,
message, and mutation metadata fields. Binary and SSE boundaries remain
explicitly outside this JSON validation family; focused malformed/error fixtures
cover the applicable response contracts.

Attachment metadata responses from file upload and audio-handle creation now
also require their non-empty identifiers at the client boundary. File download
remains intentionally binary and is documented as an exception.

Compaction-status responses now require a finite numeric progress map, with
valid, malformed, and server-error client tests. SSE, binary, and vendor-specific
boundaries remain explicit exceptions to this JSON validation work.

The dependency-free primitive guards (`isRecord`, string, and non-negative
integer checks) are now shared from `frontend/src/lib/schema.ts`; API response
guards consume that module. The closure audit still leaves SSE streams, binary
downloads, vendor URLs, and generic admin surfaces explicitly typed/documented
exceptions; IRIS-041 acceptance is complete with these documented exclusions.

The startup admin-bootstrap status response now uses the shared runtime guard
before redirect decisions, rejecting unrecognized JSON shapes without trusting
them. Remaining raw admin-control-plane/vendor boundaries are explicitly
documented exceptions under the completed typed-client audit.

Historical audit (resolved 2026-08-30): the component-local admin request
helper and status/patch parsers are now consolidated in the typed admin client,
with focused valid/malformed/error/recent-auth retry tests. `requestInstall`
and `/admin/reauth` remain intentional stream and status-only exceptions; SSE,
binary, and vendor requests remain excluded.
The status/config patch family is already protected by endpoint-specific
`parseAdminStatus` and `parseAdminPatch` guards after the shared request helper;
its lifecycle responses therefore reject malformed success payloads while the
helper preserves HTTP error messages. No duplicate generic validator was added.
`requestInstall(path, body)` is intentionally excluded from stable-JSON
migration: installation returns a newline-delimited stream of log/error/complete
events consumed through `ReadableStream.getReader()`. Existing
`parseInstallEvent`/`parseInstallResult` guards validate each event and final
result; no whole-response JSON validator is applicable.
The `/admin/reauth` flow is status-only: successful empty 2xx bodies are
accepted, while unexpected non-empty success bodies must be JSON objects;
malformed bodies fail closed without changing the existing retry/error prompt.
Final direct-call inventory found no unjustified unvalidated first-party JSON:
`App.svelte` bootstrap status uses `isBootstrapStatus`; admin-users and tool
catalog use response guards; and AdminControlPlane uses endpoint parsers. The
remaining exceptions are SSE chat/install streams, binary file/audio transfers,
vendor/tool URL fetches. The previously noted component-local admin-parser
blocker is resolved; this text preserves the audit history rather than an open
acceptance gap.

Additional progress (2026-08-28): the workspace `format:check` script now runs
recursively across packages that expose the check, and the README documents the
current Rust-only formatting scope.

Additional progress (2026-08-28): setup settings JSON is now parsed through a
strict schema that rejects invalid roots, nested values, and unknown keys while
preserving valid partial-settings merging. Managed services now inherit only
the minimal platform environment (`PATH` and required Windows variables), with
explicit configured variables still supported.

Additional progress (2026-08-28): prompt import JSON now has strict bounded
validation for metadata, collections, keys, and values, with malformed imports
rejected before partial writes. Audio-cache SQLite rows and metadata now use
runtime validation, reject unsafe file paths, and skip malformed eviction rows
safely. Backend verification passes 203 tests and typecheck.

Additional progress (2026-08-29): AdminControlPlane user management now uses
the typed admin-users client for listing, creation, role changes, password
resets, session revocation, and deletion. Existing confirmations, notices, and
unrelated admin requests remain unchanged; frontend tests and Svelte checks pass.

Additional progress (2026-08-28): disk-loaded audio metadata now rejects
malformed, scalar, invalid-encoding, and over-1 MiB content while preserving
valid metadata fallbacks. Persisted admin approval rows now use runtime
validation and fail closed before state changes. Backend verification passes
203 tests and typecheck.

Additional progress (2026-08-28): persisted frontend tool settings and prompt
overrides now validate their JSON shape before entering application state.
OpenAI-compatible model-list responses are bounded and schema-checked, with
malformed remote data rejected safely. Aggregate verification now passes 203
backend tests, 43 frontend tests, and frontend Svelte checks.

Additional progress (2026-08-28): persisted UI preferences now validate
field-by-field, preserving valid values while ignoring malformed ones. Stored
chat `loadedTools` metadata is bounded to safe names/counts and fails closed on
invalid JSON. Aggregate verification passes 203 backend tests, 43 frontend
tests, and frontend Svelte checks.

Additional progress (2026-08-28): frontend tool-call/result rendering now
guards parsed JSON shapes before accessing fields. Polling and message-display
regressions bring the frontend suite to 39 tests. Admin model database rows now
use strict Zod-backed mapping; malformed rows fail closed rather than crossing
the storage boundary as `any`.

Additional progress (2026-08-28): ComfyUI workflow persistence now validates
database rows at runtime and fails closed on malformed records. Message result
rendering now applies additional JSON size and shape guards. Aggregate
verification passes 207 backend tests, 46 frontend tests, and frontend Svelte
checks.

Additional progress (2026-08-28): persisted admin audit rows and parsed details
now validate at runtime before use. Frontend chat polling validates returned
chat objects before state updates. Aggregate verification passes 208 backend
tests, 52 frontend tests, and frontend Svelte checks.

Additional progress (2026-08-29): setup wizard progress files now use a strict
bounded schema, and AI participant tool-call payloads are bounded and
shape-validated while preserving valid neighboring calls. Backend verification
now passes 223 tests and typecheck.

Additional progress (2026-08-29): OpenAI-compatible routing now accepts only
string base-URL overrides from additional fields, and chat provider argument
JSON is bounded and restricted to non-null objects. Backend verification now
passes 225 tests and typecheck.

Additional progress (2026-08-29): staged admin patch rows now validate their
stored identifiers, status, patch, and redacted-diff JSON before use. Admin
configuration cloning is bounded to 1 MiB and reports serialization failures
without crashing the UI. Backend verification now passes 227 tests and
typecheck; frontend verification remains clean at 52 tests.

Additional progress (2026-08-29): setup wizard progress writes now use atomic
exclusive temporary files, flush before rename, and enforce `0600` permissions.
The remaining audio-service preset path is explicitly typed. Backend
verification now passes 228 tests and typecheck.

Additional progress (2026-08-29): admin status/config/checklist/default-model
responses now enter the UI through explicit runtime schemas. Chat
`read_tool_info` arguments are bounded at 64 KiB and restricted to safe object
values. Backend verification now passes 229 tests and typecheck.

Additional progress (2026-08-29): streamed provider chunks now validate
choices, deltas, tool calls, and usage fields before normalization, while
malformed chunks are ignored safely. Admin user responses now validate into an
explicit user collection instead of `any[]`. Aggregate verification passes
230 backend tests, 52 frontend tests, and frontend Svelte checks.

Additional progress (2026-08-28): admin setup-section lookup and advanced
configuration import now use typed runtime guards, rejecting inherited keys and
malformed drafts safely. Backend verification now passes 205 tests and
typecheck; frontend verification remains clean.

Additional progress (2026-08-28): admin checklist persistence now validates
rows and state values at runtime, and admin process editing uses an explicit
process type with guards instead of `any`. Backend typecheck and frontend
Svelte check pass; the latest aggregate counts remain 207 backend and 46
frontend tests.

Additional progress (2026-08-28): frontend tool-setting imports now validate
the envelope, entries, prompt overrides, and bounds while preserving valid
entries. Provider tool-call arguments are capped at 64 KiB and malformed or
non-object arguments fail closed per call. Aggregate verification passes 205
backend tests, 45 frontend tests, and frontend Svelte checks.

Additional progress (2026-08-29): admin model responses now validate into an
explicit model collection, and persisted admin configuration rows/JSON now
validate before use. Backend verification now passes 233 tests and typecheck;
frontend verification remains clean at 52 tests.

Additional progress (2026-08-29): admin approval metadata now uses a shared
Zod-validated helper in patch approval/apply paths. The service-preset typing
follow-up exposed one Svelte index-type regression during integration; it was
fixed by using an explicit string-indexed preset collection, and backend
typecheck plus frontend Svelte check pass. No service-preset behavior change is
claimed beyond that type correction.

Additional progress (2026-08-29): AI tool-result envelopes now reject malformed,
scalar, array, and oversized content. Frontend SSE parsing now discards
malformed/non-object JSON before validation. Aggregate verification passes 234
backend tests, 53 frontend tests, and frontend Svelte checks.

Additional progress (2026-08-29): managed-service lock records now enforce
bounded JSON/PID validation while preserving stale-lock recovery. The
non-destructive clean-output gate now has automated coverage proving it reports
artifacts without deleting them; those generated build directories were then
cleaned explicitly. Backend typecheck, frontend Svelte check, and the
clean-check test pass.

Additional progress (2026-08-29): the confirmed generated directories from
verification (`backend/dist`, `frontend/dist`, and `frontend/src-tauri/target`)
were removed, and both `clean:check` and its regression test now pass. Remaining
release gates are clean-install/package/upgrade/rollback validation, dependency
and artifact scans, platform coverage, and manual accessibility/UX QA.

Additional progress (2026-08-29): a fresh temporary staging workspace passed
`pnpm install --frozen-lockfile --offline` using pnpm 11.22.0 and Node 22.23.2.
A local read-only credential scan found no high-confidence leaked credentials,
but confirmed that runtime API-key material is still stored directly in the
SQLite key table; secret-store migration remains open. Synthetic test secrets
and local `.pi` transcripts are scanner false positives/local artifacts and
should remain excluded from production scans and support bundles.

Additional progress (2026-08-29): persisted API-key rows now use strict schema
validation, bounded names/values, fail-closed reads, and safe update timestamps.
The release-gate check passed format, lint, typecheck, and clean-output checks;
the pnpm offline dry-run was blocked only by the environment's local store
database. Backend verification now passes 244 tests and typecheck.

Additional progress (2026-08-29): service model-list construction now uses
explicit capability/model types, and admin discovery responses validate into a
typed state with safe empty fallback. Backend typecheck and frontend Svelte
check pass; the latest aggregate counts remain 233 backend and 52 frontend
tests.

Additional progress (2026-08-29): a final read-only plan audit reconciled
historical counts/statuses and identified the authoritative remaining gates.
Full `pnpm verify` passed with 244 backend tests, 53 frontend tests, successful
builds, and 7/7 Rust tests; generated outputs were then cleaned and
`clean:check` passed.
tests.

Additional progress (2026-08-29): the workspace now exposes a portable,
non-destructive `clean:check` gate that reports generated artifacts without
deleting them. The admin patch UI state now uses an explicit validated type,
including approval metadata. The gate correctly identified existing build
outputs in the current workspace; cleanup remains an explicit follow-up.

- Generate or share schemas/types between backend and frontend; validate network
  responses instead of asserting shapes.
- Centralize fetch credentials, errors, timeouts, abort, request IDs, 401/session
  handling, retry policy, base URL, and content limits.
- Define a discriminated union for every SSE event. Reject unknown/malformed
  events safely and version the protocol.
- Replace scattered raw admin fetches and `any` state with domain clients/types.

Acceptance: contract fixtures compile and validate on both sides; no production
`any` remains in API/admin paths.

### IRIS-042: decompose large components — IN PROGRESS

- Split `AdminControlPlane.svelte` by route/tab and domain (overview, services,
  profiles, software, models, users/sessions, keys, prompts, workflows, audit,
  confirmation). Move networking and normalization out of markup.
- Split `ToolSettingsModal.svelte` into catalog, policy, per-tool settings,
  import/export, and prompt override components.
- Keep message rendering, attachment fetch, markdown, and actions separately
  testable. Preserve sanitization and add scheme restrictions for links/images.

Acceptance: components have typed props/events, focused tests, loading/empty/
error/cancel states, and no multi-kilobyte lines.

### IRIS-043: accessibility and UX integrity — IN PROGRESS

Progress (2026-08-30): ToolSettingsModal, SettingsModal, EditCardModal,
NewAiCardModal, NewChatModal, ToolApprovalModal, and login/bootstrap
flows now provide labelled dialog/form semantics, Escape and focus-return
behavior, field-associated validation, and live non-secret error/status
announcements. Prompt-editor nested-dialog focus ordering and admin/settings
feedback have regression coverage. EditCardModal and ToolApprovalModal now have
explicit dialog naming,
initial focus, Escape dismissal, focus return, and assertive save errors. The
primary LoginScreen now exposes an explicitly named/busy form, explicit field
label associations, selected password/PIN state, and credential error linkage;
`login-a11y.test.ts` covers that contract. The
participant indexing hotspot is also covered by a pure helper test; focused
EditCardModal, NewAiCardModal, and ToolApprovalModal regression tests now pass;
LoginScreen validation and alert/focus behavior are covered as well.
Broader modal,
history virtualization, upload, offline, and manual screen-reader QA remain.

Additional progress (2026-08-31): history-window and upload-cancellation
advances now have focused regression coverage; manual screen-reader and
cross-device QA remain.

Additional progress (2026-08-30): disclosure/removal accessibility fixes now
have explicit regression tests across the affected dialogs and login flows.
Manual screen-reader, contrast, and broader history/upload/offline QA remain.

Additional progress (2026-08-30): NewChat, upload, profile, history, and
offline interaction semantics now have explicit regression coverage alongside
the dialog and login accessibility fixes. Manual screen-reader and broader
cross-device QA remain.

Reduced-motion and focus-trap edge cases now have explicit regression coverage;
broader manual and cross-device QA remains.

- Audit keyboard order, focus traps/return, Escape behavior, dialog semantics,
  labels, validation announcements, live regions, contrast, reduced motion,
  screen-reader names, and destructive confirmations.
- Replace console-only failures with actionable, non-secret user errors and
  structured diagnostics. Keep logs for operators, not as the UI.
- Virtualize or window long histories/logs and avoid repeated linear participant
  lookups during render/event filtering.
- Add upload/progress/cancel, offline/reconnect clarity, and safe draft recovery.

Acceptance: automated accessibility checks plus keyboard/screen-reader manual
smoke tests pass for login, chat, settings, tools, and admin.

## 9. Phase 5 — native audio and desktop lifecycle

### IRIS-050: correct cross-platform audio — IN PROGRESS

Progress (2026-08-29): native WAV playback now bounds decoded input to 24 MiB
and 8 million samples, rejects zero-rate/channel headers, propagates corrupt
sample decode errors, and rejects non-finite float samples. Two Rust regression
tests cover sample-count and truncated/corrupt WAV rejection. Device and
platform hardware behavior remain open. Playback now uses tested channel
mapping with bounded frame indexing, mono/stereo conversion, clipping, and
non-finite-value handling; three native audio tests pass.
Output playback now selects typed CPAL callbacks for the device's f32/i16/u16
sample format through one shared stateful callback helper; unsupported formats
fail explicitly before stream creation. The helper preserves bounded/clipped
channel mapping and rate-based frame selection while converting through CPAL's
native sample traits. Recording now likewise selects typed CPAL input callbacks
for f32/i16/u16, normalizes through CPAL conversion traits with finite/clipping
guards, and bounds captured samples to the requested duration. Hardware/platform
behavior remain open. Playback and recording now share an RAII process-wide
operation guard, rejecting conflicting concurrent operations and releasing on
success or every error return. Each active operation has an ID and atomic
cancellation flag exposed through `active_audio_operation_id` and
`cancel_audio_operation`; stale or repeated cancels are harmless, and
playback/recording loops exit promptly when canceled. Existing playback/read
return types remain unchanged for compatibility; clients discover the active
ID before issuing cancellation.
Device selection now gives case-insensitive exact names priority, permits only
unique substring matches, and rejects ambiguity explicitly. CPAL does not
provide a stable cross-platform device ID through this path, so name
persistence remains best-effort.

- Build input/output streams for the device's actual sample format (`f32`,
  `i16`, `u16`, etc.) rather than assuming `f32`.
- Replace naive playback indexing with a tested resampler/channel mapper; the
  current output/input rate ratio and channel indexing can skip or misaddress
  samples. Preserve duration and avoid clipping.
- Bound decoded WAV size/sample count and base64 input; reject corrupt samples
  rather than silently dropping decode errors.
- Make playback/recording async and cancellable, release devices on every error,
  expose permission denial clearly, and prevent concurrent-device conflicts.
- Test device-name ambiguity and persist stable device identifiers when the
  platform provides them.

Acceptance: unit tests for rate/channel/sample-format conversion and hardware
smoke tests on supported platforms; cancellation releases the device promptly.

### IRIS-051: desktop lifecycle and packaging — IN PROGRESS

Progress (2026-08-29): audited the Tauri entrypoint and frontend connection
layer. Desktop is explicitly connect-only: Tauri registers local tools but does
not start, stop, or supervise a backend. Frontend backend URL normalization and
origin validation are available, and existing probe/state logic surfaces
offline and reconnect status. Added a connect-only readiness coordinator with
starting/ready/offline/reconnecting states, generation-based stale-probe
discard, bounded abort probes, capped retry scheduling, and teardown cancel.
Packaged platform smoke tests and full startup integration remain outstanding.

- Decide whether the desktop app starts/manages a backend or connects to one;
  model startup, health, shutdown, updates, logs, and crash recovery explicitly.
- Produce signed release builds in CI for supported platforms, with SBOM,
  licenses, update policy, minimal permissions, and clean-install/upgrade tests.
- Validate paths containing spaces/non-ASCII, read-only installs, multiple app
  instances, sleep/wake, and backend URL changes.

Acceptance: packaged smoke tests pass without development dependencies or broad
filesystem/shell entitlements.

## 10. Phase 6 — observability, performance, and operations

### IRIS-060: structured, redacted observability — COMPLETE

Progress (2026-08-28): the shared logger now sanitizes common bearer/basic
authorization values, cookies, API-key formats, tokens, passwords, and secrets
for both console and file logs, including serialized structured values and
error stacks. File logs now rotate to a `.1` sibling before exceeding a 5 MiB
bound, with regression coverage. Seeded regression coverage passes; structured
fields, metrics, and audit/export coverage remain. Rotation replaces the
previous sibling deterministically so retained log storage stays bounded.

Additional progress (2026-08-29): request middleware now generates and returns
validated request IDs, accepts a separate bounded correlation ID, and emits a
sanitized structured access/error record containing method, pathname, status,
duration, outcome, and IDs without query, headers, or body. Seeded tests prove
secret-bearing inputs do not appear in captured logs.

Additional progress (2026-08-30): read-time legacy log records now pass through
the shared redaction boundary before console/file output; seeded audit coverage
proves legacy authorization, cookie, key, and token values are not emitted.
Structured fields, metrics, and audit/export coverage remain open.

Additional progress (2026-08-30): configuration export/support-bundle output
now applies the shared redaction boundary recursively, including legacy nested
credential fields; regression coverage verifies secrets do not cross the export
boundary.

Additional progress (2026-08-30): health/readiness endpoints, bounded metrics,
shared request/error envelopes, and seeded secret, circular-error, and bounded
error tests are implemented. IRIS-060 remains in progress pending complete
support-bundle/error-path redaction evidence and the full standardized
observability field and metrics contract.

Additional progress (2026-08-30): SSE active-client gauges and generation
observer counters/gauges now emit opaque bounded events with sink isolation;
concurrency tests verify balanced gauges and no cross-talk. The broader
observability field, metrics, and support-bundle contract remains open.

The secure deterministic bounded support-bundle primitive and recent-auth admin
endpoint now have unauthorized, fresh-session, stale-session, secret-redaction,
and bounded-output coverage. The export/redaction sub-clause is materially
complete; overall IRIS-060 remains in progress for the broader observability
field/metrics and end-to-end support-bundle/error-path contract.

Tool-wait cancellation/timeout cleanup, database/cache/service metrics, chat
error envelopes, and the observability contract documentation are covered by
focused tests. The broader standardized field and end-to-end redaction contract
remains open.

- Standardize log levels/fields, request and generation IDs, component, actor
  pseudonym, chat ID pseudonym, duration, outcome, and error code.
- Redact tokens, cookies, keys, prompts/messages, tool args/results, environment,
  local paths, and bootstrap secrets by default. Cap/rotate files.
- Add health/readiness endpoints that do not leak config, and metrics for queue
  depth, SSE clients, generations, tool waits, DB latency, cache size, service
  ownership, and failures.

Acceptance: redaction tests use seeded secrets and prove none appear in logs,
errors, audit exports, or support bundles.

Closure (2026-08-31): AST zero-violation envelope guards, matching log levels,
pseudonyms, the complete fixed metrics set, seeded redaction/error/audit/config/
support-bundle tests, health/readiness endpoints, and policy coverage satisfy
IRIS-060 acceptance.

### IRIS-061: measured performance work — IN PROGRESS

Progress (2026-08-29): frontend message rendering now builds a keyed participant
index once per participant collection instead of scanning participants for each
message. Correctness and operation-count regression tests cover fallback and
large message/participant sets. Broader measurement, budgets, query/cache
hotspots, and published before/after benchmarks remain.

Progress (2026-08-31): two deterministic performance slices are now covered:
the frontend participant-index operation-count contract and the backend prompt
construction contract for large histories. Both use repeatable fixtures and
assert bounded work while preserving output. Broader startup/query/SSE/tool/
compaction/file/admin measurements, published before/after benchmarks, and
regression budgets remain.

Progress (2026-08-31): a third deterministic slice now covers the backend
history query path with a 5,000-message fixture: exactly 50 ordered pages of
100 with no duplicates. The focused performance command passes its prompt and
history-query checks (2/2). The snapshot counts above predate this added test;
the full verification gate was green immediately before the slice landed.

Progress (2026-08-31): a fourth deterministic slice exercises SSE fanout with
1,000 clients, verifying one close per client, complete draining, and
idempotent repeated shutdown. A fifth exercises the tool loop with 8 × 8 raw
calls and verifies the bounded 32-call acceptance limit. The focused tool-loop
performance suite passes 4/4; it postdates the full verification gate.

Progress (2026-08-31): a sixth deterministic slice exercises compaction with a
2,000-message fixture and a fake provider (no network). It verifies content and
order preservation, merge behavior, system-message exclusion, cursor
persistence, and a 40-byte-per-message input budget. The focused performance
suite passes 5/5.

Progress (2026-08-31): a seventh deterministic slice exercises file transfer
with the real `FilesProvider`: a 196,625-byte payload is transferred in four
64 KiB data chunks across two operations, remains byte-identical, and rejects
`max_bytes` overflow without network access or wall-clock dependence. The
focused performance suite passes 6/6; it was added after the preceding full
verification gate.

Progress (2026-08-31): an eighth deterministic slice exercises admin load with
a 1,200-row audit fixture. `listAudit` performs one database operation and
returns exactly the 1,000 newest unique rows ordered by timestamp and ID. The
focused performance suite passes 7/7; the preceding full-gate snapshot was
107 backend files/588 tests and all recorded gates were green.

Progress (2026-08-31): a ninth deterministic slice exercises startup with 64
provider configurations using the real `kernel.start`. Each provider is
initialized and registered exactly once with a zero-network initialization
budget. The focused performance suite passes 8/8; the preceding full
verification snapshot was 108 backend files/589 tests with all recorded gates
green.

- Benchmark startup, chat list/history queries, prompt construction, SSE fanout,
  tool loops, compaction, file transfer, admin load, and large histories.
- Fix verified hot spots: N+1 queries, repeated config/prompt filesystem reads,
  repeated participant scans, unbounded instance/catalog caches, base64 copies,
  and sequential independent work.
- Add cache ownership, bounds, invalidation, and shutdown cleanup. Do not add
  caching without measurement and correctness tests.

Acceptance: publish before/after benchmarks and enforce generous regression
budgets in repeatable jobs.

Strict acceptance audit (2026-08-31): the nine deterministic slices establish
repeatable operation contracts for participant indexing, prompt construction,
history queries, SSE fanout, tool loops, compaction, file transfer, admin load,
and provider startup. IRIS-061 remains IN PROGRESS because empirical
production before/after comparisons are not yet available, baseline regression budgets are
now enforced for the current operation contracts, and broader measured hotspot
optimizations remain incomplete. The tool-document cache now has explicit
ownership, a deterministic 256-entry FIFO bound, override invalidation, and a
production shutdown clear; broader cache ownership across live chat instances
and measured optimization evidence remain.

Progress (2026-08-31): `performance-baseline.json` now publishes deterministic
baselines and budgets for all nine contracts. Schema, nonnegative-value,
current-at-or-below-budget, and delta checks pass in the performance suite
(9/9), closing the baseline-budget sub-gap. The full-gate counts above include
this artifact; real empirical before/after production measurements and broader
cache/measured optimization evidence remain required.

Progress (2026-09-01): the built-in prompt-file cache now has explicit
ownership, a fixed 256-entry FIFO bound, and a production shutdown clear;
focused prompt tests cover cardinality and cleanup. The optional measured
report now rejects workload-set mismatches and throughput regressions during
comparison. Its synthetic microbenchmarks and process-local heap samples are
documented as non-production evidence; empirical before/after production
measurements and broader measured optimization evidence remain required.

Progress (2026-09-01, measured comparison): the optional report now measures
the same seeded participant fixture with the former linear scan and current
indexed lookup, recording median delta and speedup (approximately 4.58x in
the verified run). The comparison avoids dead setup work and validates exact
workload sets plus throughput direction. It remains hardware-sensitive and is
not production before/after evidence; broader measured optimization evidence
remains required.

Progress (2026-09-01, history comparison refinement): the real SQLite history
report compares identical newest-100 first-page scopes and validates exact
ordered full traversal, cursor progression, page counts, and `hasMore`. The
measured artifact records a first-page ratio of approximately 3.96x (speedup)
while the full traversal ratio is approximately 0.075 (tradeoff), because the
comparison intentionally distinguishes bounded first-page work from complete
5,000-row traversal. Heap ratios are reported as before/current and are
process-local diagnostics, not production memory claims.

Progress (2026-09-01, genuine history comparison): the optional report now
uses a canonical disposable SQLite fixture with 5,000 messages and compares a
full SQLite load/in-memory traversal against production `getHistoryPage` with
100-row `LIMIT + 1` pages. The verified sample measured approximately 1.60 ms
versus 21.26 ms median (about 0.075x full-traversal speed) for the paginated
path, honestly documenting that pagination trades whole-history latency for
bounded memory and incremental delivery; ordering and duplicate assertions
remain enforced. This is real production-seam evidence but not a claim of
faster complete-history retrieval; broader measured before/after workload
comparisons remain required.

### IRIS-062: operational recovery — IN PROGRESS

Progress (2026-08-29): added an idempotent shutdown coordinator boundary that
drains registered resource hooks and tolerates already-closed resources; unit
coverage is deterministic. Backend startup now installs SIGTERM/SIGINT once and
closes the HTTP listener through the coordinator; SSE owner registration and
resource-specific drains remain open. SSE connections now register an explicit
close boundary and are drained by shutdown; post-close queue writes are ignored.
SQLite owners now register handles centrally; shutdown checkpoints WAL and
closes each handle idempotently. Regression coverage verifies closed handles
reject subsequent operations and confirms SSE cleanup is ordered before the
database hook.
Owned managed services now expose a stop-all-owned-only boundary and are
registered during startup shutdown; foreign/reused services are not targeted.

Progress (2026-08-30): accepted a local recovery command handler and CLI
workflow with lazy auth/database isolation, strict confirmation and argument
validation, manifest confinement, and regular-file checks. CLI and primitive
coverage now totals five focused tests. Retention/scheduling, shutdown and
key-rotation integration, and end-to-end recovery drills remain open.

Additional progress (2026-08-30): offline retention planning/apply CLI safety,
tests, and operator documentation are implemented as a bounded sub-slice.
Overall IRIS-062 remains in progress pending scheduling integration, shutdown
and key-rotation integration, and end-to-end recovery drills.

Additional progress (2026-08-30): scheduler policy parsing, readiness-gated
startup, shutdown lifecycle, structured warning/error logging, and bounded
metrics evidence are covered by focused tests. Broader operational recovery
integration, key rotation, retention scheduling policy, and production drills
remain open.

Progress (2026-09-01, recovery-pair correctness): the recovery publisher no
longer performs a post-publication `chmod` that could create a failure window.
Staged files are created with owner-only `0600` permissions and promoted by
hard-link, preserving mode; Unix final-mode assertions and recovery/recovery-
pair coverage pass 18/18. Windows filesystem semantics and the remaining
descriptor-relative race evidence are still open, so IRIS-062 remains
IN PROGRESS.

Additional progress (2026-08-30): the automated retention recovery drill and
its documented runbook command now cover backup, manifest verification, restore,
and cleanup in a temporary root. Scheduling and production integration remain
open, so the overall ticket stays in progress.

Additional progress (2026-08-31): the operational slice now includes an
exclusive live maintenance lock, durable bounded API-key-rotation audit
statuses, safe lost-admin recovery with session revocation, confined offline
cache purge, ENOSPC-aware recovery filesystem behavior, and ordered shutdown
draining. Focused tests cover lock ownership, credential/session recovery,
cache confinement, disk-full handling, audit safety, and shutdown ordering.
IRIS-062 remains in progress only for external/tabletop and full incident-drill
evidence, plus hosted scheduling/production integration evidence.

- Document backup/restore, key rotation, lost-admin recovery, corrupted DB,
  failed migration, stuck lock, disk full, broken managed service, cache purge,
  logs/support bundle, and rollback.
- Add graceful shutdown: stop accepting work, close SSE, cancel generation/tool
  waits, checkpoint/close SQLite, and apply service shutdown policy only to owned
  processes.

Acceptance: tabletop and automated recovery drills succeed from documented
steps without source-tree surgery.

## 11. Phase 7 — documentation and roadmap consolidation

### IRIS-070: establish a documentation hierarchy — IN PROGRESS

Progress (2026-08-28): added `monorepo/docs/architecture` and
`monorepo/docs/decisions` indexes plus ADRs for guest identity, server-side
whisper filtering, disposable test data, and service endpoint policy. The
root README and remaining legacy guideline/memory reconciliation are still
open.

- Root README: user/developer entry point.
- `docs/architecture`: current system and boundaries only.
- `docs/decisions`: dated ADRs for guest identity, whisper routing, multiple
  databases, admin authority, local-vs-backend tools, managed services, and data
  locations.
- `docs/operations`: deploy/security/recovery/platform support.
- `docs/api`: generated or contract-checked endpoint/event schemas.
- Keep roadmap as unfinished outcomes only; use the issue tracker for tickets.

Reconcile `backend/docs`, `backend/guidelines`, `memory.txt`, source comments,
and `roadmap.txt`. Remove duplicated/stale documents only after unique durable
constraints are migrated and links are updated. Fix roadmap duplicate numbering.

Acceptance: every durable claim has one authoritative home and a validation
owner; docs links/checks pass in CI.

### IRIS-071: explicitly disposition unfinished features — COMPLETE

Progress (2026-08-30): `monorepo/docs/roadmap-disposition.md` inventories all
current roadmap items and assigns deliver, redesign, or defer dispositions with
dated review criteria. It is linked from the architecture index and explicitly
separates shipped boundaries from production-readiness claims.

Closure (2026-08-31): the canonical roadmap parser and disposition checks cover
all 13 current roadmap items exactly once, with unique IDs/numbering, valid
dispositions, dated criteria, and explicit readiness limitations. Documentation
checks pass and no shipped endpoint/UI is represented as production-ready when
its safety or lifecycle remains unfinished.

For each current roadmap item—admin production hardening, resource policies,
managed downloads, audio platform coverage, ComfyUI UX, CLI migration, prompt
quality, thinking-tag handling, onboarding, Hono workaround, packaging, search,
and multi-device sync—choose deliver, redesign, defer with criterion/date, or
remove. Do not leave half-enabled public surfaces such as stubbed plugin schema
validation.

Acceptance: no shipped endpoint/UI claims production readiness while its safety
or lifecycle is explicitly unfinished.

## 12. Deletion and removal register

This table lists remaining deletion candidates only. Previously removed nested
workspace files, duplicate auth registration, generic passthrough routes, and
confirmed unused symbols are recorded in their owning ticket history rather
than presented as future work. Deletion is not authorized until the named
prerequisite is met.

| Candidate                                                           | Why                                                                                                                                                                                                                                                           | Prerequisite                                                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| All `node_modules` trees                                            | Reproducible dependencies, huge/noisy                                                                                                                                                                                                                         | Root lockfile verified; ignore policy                                                     |
| Backend/frontend `dist`                                             | Generated output                                                                                                                                                                                                                                              | Clean builds verified                                                                     |
| `frontend/src-tauri/target`                                         | 3.8 GB generated Rust output                                                                                                                                                                                                                                  | Cargo build verified; ignore policy                                                       |
| Python `.venv` and managed software from source tree                | 21 GB runtime/vendor state; breaks tests                                                                                                                                                                                                                      | Backup, ownership manifest, external runtime root                                         |
| SQLite DB/WAL/SHM, setup, locks, cache, user files from source tree | User/runtime/secrets                                                                                                                                                                                                                                          | IRIS-001 and IRIS-014 migration                                                           |
| Unused `execInContainer` import and dead native-audio variable/path | `execInContainer` had no callers and was removed 2026-08-30; native-audio/model-registry paths remain intentionally documented dead UI pending product disposition                                                                                            | Backend typecheck/provider tests pass; retain documented UI until IRIS-071                |
| Interactive PTY commands/session state                              | Retained: backend `shell_interactive` is advertised/reachable and Tauri registers `tool_shell_interactive`; frontend currently exposes only one-shot execution. It is not dead, but descendant/process-group cleanup and cross-platform lifecycle remain open | IRIS-015/051 platform lifecycle tests and product UX decision                             |
| Obsolete `will_reply_prompt` storage/fixtures                       | Retained: current chat schema and runtime mapping still read/write `willReplyPrompt`; historical upgrades also preserve the column                                                                                                                            | Remove only after API/schema redesign, then versioned migration and compatibility fixture |
| Duplicate frontend DOM sanitizer dependency                         | Resolved 2026-08-30: `markdown.ts` imports `isomorphic-dompurify`; direct `dompurify` dependency removed while it remains transitive                                                                                                                          | Frontend tests/check/build and license check passed                                       |
| Stale guideline/architecture copies                                 | Contradictory maintenance burden                                                                                                                                                                                                                              | IRIS-070 content migration/link check                                                     |
| Empty `QUESTIONS.md` and ad-hoc `memory.txt` role                   | Weak issue/decision tracking                                                                                                                                                                                                                                  | Move durable content to ADR/docs; preserve history                                        |

Also investigate the top-level `:memory:.ses`, `.pi` agent artifacts, and empty
`.git` representation in this snapshot. Do not delete them until ownership and
environment purpose are known.

## 13. Recommended agent lanes and dependency graph

Do not dispatch many agents into the same monolith simultaneously. Suggested
lanes:

1. Data/repository lane: IRIS-000 -> 001 -> 014 -> 020 -> 021.
2. API security lane: IRIS-010 -> 011 -> 012 -> 013 -> 016.
3. Desktop security lane: IRIS-015, then IRIS-050/051.
4. Test/tooling lane: IRIS-020 -> 022; it may start once inventory rules are
   known and should land before large refactors.
5. Backend architecture lane: IRIS-030 -> 031/032 -> 033/034/035.
6. Frontend lane: IRIS-041 first, then 040 and 042/043.
7. Operations/docs lane: IRIS-060/062 and IRIS-070/071 after security contracts
   stabilize; IRIS-061 follows representative architecture changes.

Safe early parallelism: API privacy tests, Tauri adversarial tests, Vitest
scoping, data inventory, and documentation hierarchy design touch mostly
separate files. Unsafe parallelism: multiple agents editing `api.ts`, `chat.ts`,
`database.ts`, `state.svelte.ts`, or `AdminControlPlane.svelte` before those are
split.

## 14. Pull-request contract for dispatched agents

Every agent brief should include:

- ticket ID, exact outcome, allowed file scope, and explicitly excluded work;
- threat model/data migration concerns and compatibility window;
- tests to write before implementation;
- commands and platform matrix to run;
- documentation/ADR to update;
- rollback method and telemetry needed to validate rollout.

Every pull request must report:

1. observed pre-change failure or risk;
2. chosen design and rejected alternatives;
3. schema/API/data/security impact;
4. tests added and exact results;
5. manual verification performed;
6. rollback/recovery instructions;
7. follow-up tickets, with no hidden TODOs.

Definition of done:

- acceptance criteria and negative tests pass;
- typecheck, lint, format, unit/integration tests, builds, and applicable Rust or
  platform jobs pass from a clean checkout;
- no production/runtime data was used or modified by tests;
- no new warnings, `any`, secrets, unbounded buffers, or ignored failures;
- public contracts and durable docs are updated;
- a clean run leaves no untracked/unignored output;
- reviewer can revert the change without corrupting data.

## 15. Final release gates

Iris should not be called production-ready until all of these are true:

- chat creation cannot impersonate/enroll arbitrary human identities or exclude
  its creator, and the full route matrix is deny-by-default;
- network-level privacy tests prove whispers and tool requests are scoped while
  intended recipients still receive correct live/done/audio/truncation events;
- anonymous/guest/user/admin route matrix is complete and deny-by-default;
- all request bodies and remote/provider responses are runtime-validated and
  bounded;
- attachments and their messages are failure-atomic, and file/download bounds
  apply during I/O rather than after whole-value materialization;
- secrets/runtime data are outside source and backup/restore is proven;
- API keys use approved secret-at-rest storage; authentication throttling does
  not create a trivial targeted account-lockout or multi-instance bypass;
- native shell/files/docs pass adversarial queue, symlink-root, race, read/write
  bound, descendant, and PTY-output tests, and Tauri has an appropriately scoped
  CSP/external-navigation policy;
- managed software is pinned and verified, cancellation terminates descendants,
  and SSRF policy covers DNS resolution/rebinding and all upstreams;
- versioned migrations pass historical fixtures and failure injection;
- native audio passes bounded decode, sample-format, resampling/channel,
  cancellation, and supported-platform tests;
- clean install, verify, build, package, upgrade, rollback, and recovery pass on
  every supported platform;
- dependency/license/secret scans and signed artifacts/SBOM are in place;
- accessibility and key user/admin flows pass manual smoke testing;
- the roadmap accurately lists only remaining work.

## 16. Immediate dispatch order (re-audited 2026-08-29)

Completed across the three latest batches: creator-bound chat creation;
exclusive/bounded attachment I/O with normal-failure compensation; bounded
captured and interactive native shell paths; improved source/account sign-in
throttling; authenticated encrypted API-key storage and legacy migration;
connection-pinned DNS-aware service probes; and immutable, owned, cancellable
managed installers. The newest batch also adds durable attachment staging and
reconciliation, supported transactional API-key rotation with securely loaded
key files, and pinned,
bounded production ComfyUI transport. Full verification passes at the snapshot
counts above. The latest local continuation adds safe audience-scoped replay,
the shared outbound transport and its non-streaming callers, and descriptor-
relative Unix file-jail I/O.

The next assignments should remain separate, narrowly scoped changes:

1. IRIS-010/031: recipient-scoped post-completion replay is safe and remains
   fail-closed when scope is absent or malformed, including `audio_ready`.
   An explicit `emitScopedStream` boundary now requires a validated audience
   and emits a versioned routing frame before content; the current model
   producer does not invoke it because final @mention routing is unavailable
   until completion. Remaining work is wiring provider-side audience metadata
   into that boundary, retaining buffered fallback for legacy/malformed
   producers, and adding end-to-end timing tests.
2. IRIS-016/034: move streaming model completions onto a pinned, backpressured
   transport, then consolidate the equivalent service, ComfyUI, and shared
   outbound policies without weakening their endpoint-specific bounds. Model
   generation now defaults to unlimited for very slow hardware; add an
   explicit finite override in the Admin Control Plane later, while keeping
   cancellation and user interrupts independent of that timeout. Other
   outbound operations remain bounded by their endpoint-specific policies.
3. IRIS-015: add equivalent handle-relative jailed I/O on supported non-Unix
   platforms, adversarial swap stress tests, portable descendant behavior, and
   Docker image digest pinning.
4. IRIS-014: exercise backup/restart/recovery for master-key rotation and
   evaluate OS-keyring integration for desktop deployments.
5. IRIS-016: add signed/checksummed artifact distribution, disk-space checks,
   staging/atomic promotion, and install rollback.
6. IRIS-013: define multi-instance/distributed limiter ownership, operational
   thresholds, and metrics before remote production deployment.
7. IRIS-022/021: install actual ESLint/Prettier policy and CI/scanner/coverage
   gates, and reconcile `verify` with the clean-output invariant.

Recent-auth step-up enforcement: high-risk admin mutations now require a
server-verified Better Auth password reauthentication or a session younger than
five minutes. Grants are hashed, SQLite-backed, bounded, and expire after five
minutes. Frontend prompting/handling of `recent_auth_required` is implemented
through the accessible reauthentication prompt and single-retry coordinator
flow; broader step-up policy coverage and operational tuning remain. Clients
must call `/api/admin/reauth` and retry once.

After these boundary fixes land, proceed with IRIS-030/031/032/034/035 and
IRIS-040/042 decomposition. Native audio, packaging, accessibility,
performance, recovery, and documentation disposition remain required work, not
post-release optional polish.

### IRIS-062 SQLite recovery primitive

Implemented bounded offline backup/restore in `monorepo/backend/src/db/recovery.ts`
and its local CLI handler:
caller-supplied roots, SQLite online backup (including WAL), same-parent private
staging, integrity and SHA-256 manifest verification, and atomic no-overwrite
promotion. Restore is gated on closed handles and preserves targets on failure.
Nested and intermediate symlink components are rejected for source, destination,
and manifest paths. Residual Node path-check/open TOCTOU exposure remains in the
production threat model; this is not claimed as descriptor-relative safety.
The recovery drill command exercises backup, manifest-verified restore, and
temporary-root cleanup without mutating repository data.
The canonical backup contract places the manifest under the caller-provided
temporary root, uses private 0600/no-overwrite files, rejects component
symlinks, consumes the same manifest during restore, and removes both backup
and manifest if manifest creation fails.
Remaining scope is full orchestration: retention/scheduling, key-rotation and
shutdown integration, exports, operator workflow, and end-to-end production
recovery drills. No destructive HTTP endpoint is provided.

### IRIS-032 participant atomicity follow-up

The paired `participants`/`ai_participants` writes are atomic through the
synchronous repository boundary; success and real constraint-failure rollback
coverage are implemented. Broader repository decomposition and cross-resource
atomicity remain open.

### IRIS-033 auth/admin/API-key migration audit

Prompts, admin, memory, and API-key stores now have version-1 ledgers with
idempotent migrations, preservation checks, and fresh-database failure rollback
coverage. API-key legacy plaintext encryption migration remains covered.
Better Auth-owned auth tables and remaining config/auxiliary store ownership
boundaries are explicitly outside this application-ledger scope.

### IRIS-033 remaining store inventory

Config storage now has an idempotent version-1 migration ledger with
preservation and failure-rollback coverage. Remaining migration ownership gaps
are limited to Better Auth-owned
`user/session/account/verification` tables and the explicitly scoped
config/auxiliary families; no application-owned ledger claim is made for those
external or not-yet-consolidated boundaries.

### IRIS-033 auxiliary schema inventory (2026-08-30)

The Iris-owned `CREATE TABLE` families `admin_bootstrap`, `admin_models`,
`admin_comfy_workflows`, and `admin_tts_playback` now each have version-1
ledger coverage with idempotency/preservation and fresh-database rollback
tests, while remaining separately initialized. Better Auth tables and its
colocated limiter/recent-auth tables remain excluded.

### IRIS-033 historical-schema acceptance inventory

The nine owned ledger families now have explicit version-1 initializers. Only
chat and API keys have supported historical schemas (covered by legacy fixtures);
prompts, memory, config, and the four admin families have no supported v0
contract. Their injected fresh-failure tests establish convergence/rollback;
inventing historical fixtures would misstate compatibility. Recovery remains
the documented rollback mechanism: create a verified backup pair, stop handles,
run migration, verify ledger/data, and restore the pair on failure.
