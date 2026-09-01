PromiEvent - a promise with on(event: string) callbacks, which resolves after the final event of a chain (e.g. on plugin being up and running)

EventListener - same as above, but never resolves

## ASSUMPTIONS
- PromiEvent and EventListener were **cut entirely** as requested: nothing else in the specs referenced them, and plain Promises/AsyncIterables cover all current use cases.
- Added JsonValue/JsonObject helper types for provider schema plumbing.
