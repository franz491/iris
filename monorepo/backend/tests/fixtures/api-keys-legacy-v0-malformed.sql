CREATE TABLE api_keys (name TEXT PRIMARY KEY, key TEXT NOT NULL, created_at INTEGER NOT NULL);
INSERT INTO api_keys VALUES ('valid-fixture', 'valid-secret', 1700000000);
INSERT INTO api_keys VALUES ('bad-fixture', '', 1700000001);
