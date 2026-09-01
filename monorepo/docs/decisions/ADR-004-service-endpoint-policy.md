# ADR-004: Validated local service endpoints

- Status: accepted, current behavior
- Scope: admin-configured service definitions and health probes

Service definitions accept only HTTP(S) URLs without credentials or fragments. Metadata and link-local destinations are rejected. Built-in services default to loopback endpoints, and health probes use bounded responses, a five-second timeout, and no redirect following.

This is the current outbound-service boundary, not a claim that all network clients share one centralized policy. Enforcement: [`backend/src/admin/services.ts`](../../backend/src/admin/services.ts#L46-L96); regression coverage: [`backend/tests/admin-services.test.ts`](../../backend/tests/admin-services.test.ts#L3-L4).
