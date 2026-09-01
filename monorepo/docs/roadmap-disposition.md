# Unfinished feature disposition

Authoritative review: 2026-08-30. This document records whether each item in
[`roadmap.txt`](../roadmap.txt) is deliverable, needs redesign, or is deferred.
Dates are review checkpoints, not promises. A feature remains unfinished until
the stated criterion is evidenced by code, tests, and supported-platform
validation.

| Roadmap item                     | Disposition | Criterion and review date                                                                                                                              |
| -------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admin production hardening       | redesign    | Define MFA, proxy trust, recovery, and packaging contracts, then add remote/headless regression coverage; review 2026-09-30.                           |
| Runtime resource policies        | redesign    | Specify measurable memory/VRAM budgets, contention ownership, idle unload, and fallback behavior before enabling enforcement; review 2026-09-30.       |
| Managed runtime/model downloads  | redesign    | Require signed/checksummed artifacts, immutable versions, cancellation, and owned-asset removal tests; review 2026-09-30.                              |
| Audio platform coverage          | defer       | Keep current bounded Linux behavior; revisit after macOS/Windows device CI is available; review 2026-10-31.                                            |
| ComfyUI workflow UX              | defer       | Revisit when workflow graph, websocket lifecycle, gallery, and cancellation contracts have an owner; review 2026-10-31.                                |
| CLI API migration                | redesign    | Enumerate remaining mutating commands and retain only authenticated API clients plus an explicit localhost recovery surface; review 2026-09-30.        |
| Prompt quality                   | defer       | Revisit with representative local-model fixtures and scored tool/setup/memory cases; review 2026-10-31.                                                |
| Thinking-tag handling            | deliver     | Implement parser/template contract and add literal-tag, malformed-tag, and streaming tests before advertising structured reasoning; review 2026-09-30. |
| Default model onboarding         | deliver     | Setup must validate a selected reachable default model before completion and before first chat; review 2026-09-30.                                     |
| Model generation timeout control | deliver     | Add an Admin Control Plane finite-timeout override while keeping generation unlimited by default and cancellation independent; review 2026-09-30.      |
| Hono router workaround           | defer       | Re-test after a Hono upgrade; merge auth routing only when static-route regression tests pass; review 2026-10-31.                                      |
| Tauri packaging                  | defer       | Require supported-platform release builds, signing, and CI evidence; review 2026-10-31.                                                                |
| Search provider                  | defer       | Add a supported local/API provider with bounded transport and offline fallback contract; review 2026-10-31.                                            |
| Multi-device profile sync        | redesign    | Explicitly classify syncable preferences and keep execution/device secrets local; review 2026-09-30.                                                   |

No roadmap item is a production-readiness claim. Existing endpoints and UI are
supported only within their implemented, tested boundaries; unfinished lifecycle,
security, or platform behavior remains excluded from release claims.
