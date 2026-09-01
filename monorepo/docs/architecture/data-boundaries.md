# Data boundaries

## Application data

SQLite and related runtime files live under `IRIS_DATA_DIR` when configured. Without that variable, the backend uses the platform application-data location rather than the source tree. The data root is created with mode `0700`; a configured root may not be a symbolic link, and `dataFile` rejects paths outside the root. See [`backend/src/db/sqlite.ts`](../../backend/src/db/sqlite.ts#L1-L61) and [`backend/tests/data-directory.test.ts`](../../backend/tests/data-directory.test.ts#L5-L36).

## Test data

Backend tests set `IRIS_DATA_DIR` to a fresh directory under the operating system temporary directory before database modules are imported. Individual suites commonly create their own temporary root. This makes test databases and generated test files disposable and keeps them outside the repository data directory. See [`backend/tests/setup.ts`](../../backend/tests/setup.ts#L1-L10) and [`backend/tests/api-integration.test.ts`](../../backend/tests/api-integration.test.ts#L1-L15).

This is a test-isolation boundary, not a statement that production data is ephemeral: the non-test default is an application-data directory and is intended to persist between runs.
