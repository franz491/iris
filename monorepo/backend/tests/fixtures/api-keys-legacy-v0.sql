CREATE TABLE api_keys (name TEXT PRIMARY KEY, key TEXT NOT NULL, created_at INTEGER NOT NULL);
INSERT INTO api_keys VALUES ('legacy-fixture', 'legacy-secret', 1700000000);
