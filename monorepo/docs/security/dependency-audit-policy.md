# Dependency vulnerability policy

Hosted Linux CI runs `pnpm audit:policy` after the frozen install. It performs
two network-backed lockfile audits: production dependencies block high and
critical findings, while development-only findings block critical severity.
The production audit uses pnpm's `--prod` scope; the full audit is retained for
development tooling. Registry/network errors fail the job rather than being
treated as a clean result.

Temporary exceptions belong in the root `audit-policy.json`. Each exception
must name one package, severity, scope (`production`, `development`, or `all`),
an owner, a reason, and an ISO expiry date in the future. Exceptions are
package- and scope-specific and cannot suppress a finding more severe than the
recorded exception. Expired or malformed records, and a disabled policy, fail
closed. Exceptions require security-owner review and should be removed as soon
as the dependency is upgraded.

The audit is intentionally not part of deterministic offline `pnpm verify`:
the registry is an external dependency. Hosted CI is the enforcement point;
operators may run `pnpm audit:policy` locally when registry access is available.
