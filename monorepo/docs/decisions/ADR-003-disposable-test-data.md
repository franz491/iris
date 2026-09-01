# ADR-003: Disposable test data roots

- Status: accepted, current test convention
- Scope: backend tests

Tests must set `IRIS_DATA_DIR` to a temporary directory before importing database modules. The shared setup creates a fresh OS-temporary root, and suites may create narrower roots. Test databases, settings, caches, and generated files therefore do not use the repository or the normal application-data directory.

The database bootstrap also rejects a symlinked configured root and paths escaping that root. Enforcement and examples: [`backend/src/db/sqlite.ts`](../../backend/src/db/sqlite.ts#L20-L61), [`backend/tests/setup.ts`](../../backend/tests/setup.ts#L1-L10), and [`backend/tests/data-directory.test.ts`](../../backend/tests/data-directory.test.ts#L19-L36).
