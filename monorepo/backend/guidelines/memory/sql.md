sql.ts - on memory access, it verifies that only public notes or private one for the only human user in the chat are retrievable. Multiple human users - no private memories can be retrieved.

All queries to SQLite are called through here, as well as writes. This is the file that interfaces TS and SQL

## ASSUMPTIONS
- Single `memories` table with type column instead of 4 tables (same query shape, simpler migrations).
