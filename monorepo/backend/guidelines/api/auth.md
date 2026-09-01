auth.ts - verifies the user session based on their pin/password/... using BetterAuth. Every session can be authed as one user or non-authed.

## ASSUMPTIONS
- BetterAuth with its own SQLite db (<dataDir>/auth.db), emailAndPassword enabled; the credential field doubles as PIN or password. validateCredential enforces PIN=4-8 digits when numeric-only was chosen at registration; otherwise min length 4.
- Pattern unlock deferred (see QUESTIONS.md).

## ANSWERS
- Users are registered by an admin on the backend machine. Registered users can change their own credential and credential style (PIN <-> password) in the desktop settings; other sessions are revoked. Pattern unlock is deferred.

## IMPLEMENTED
- Guest user: unauthenticated requests map to a shared GUEST_USER_ID ("guest"); guests can access only chats with no registered users (chat/auth.ts isUserAuthorizedInChat). ASSUMED accepted: all guests share one identity.
- BetterAuth tables (user/session/account/verification + admin plugin columns) are created by raw SQL at import since BetterAuth doesn't migrate raw SQLite dbs.
