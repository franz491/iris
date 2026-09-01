# Architecture

This directory describes the runtime boundaries currently implemented in Iris. These documents are implementation notes, not future-state design.

## Boundary map

- [Runtime boundaries](runtime-boundaries.md) — request identity, guest access, and message delivery.
- [Data boundaries](data-boundaries.md) — application data roots and disposable test state.
- [Security boundaries](security-boundaries.md) — server-side filtering and outbound service policy.

The corresponding decisions are recorded in [`../decisions/`](../decisions/README.md). Source links in these documents point to the enforcing code and regression tests.

The current roadmap disposition is recorded in [`../roadmap-disposition.md`](../roadmap-disposition.md).
