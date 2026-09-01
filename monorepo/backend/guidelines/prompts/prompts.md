prompts.ts - database with prompt preferences per user, plus all global prompts

## ASSUMPTIONS
- Simple key/value store: user-specific override wins over global; SQLite at <dataDir>/prompts.db.
