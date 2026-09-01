# ADR-001: Shared guest identity and universal guest chat

- Status: accepted, current behavior
- Scope: unauthenticated chat sessions

Iris maps an unauthenticated request to the stable user ID `guest`. Guests may use chats with no registered users, but cannot access chats containing registered users and are not included in ordinary membership listings. Guest sessions use the universal guest-chat endpoint rather than creating personal chats.

This keeps guest authorization explicit at the backend boundary and avoids treating an absent session as an account. Enforcement: [`backend/src/api/api.ts`](../../backend/src/api/api.ts#L170-L201), [`backend/src/chat/auth.ts`](../../backend/src/chat/auth.ts#L8-L28), and [`backend/src/chat/database.ts`](../../backend/src/chat/database.ts#L658-L669).
