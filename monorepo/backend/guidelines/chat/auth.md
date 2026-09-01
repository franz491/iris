auth.ts - verifies access to the chat based on frontend authentication

isUserAuthorizedInChat(chatId, userId)

whether the user is in the chat.


isUserAuthorizedRead(participantId, userId)

returns true if participant.role === "user" and participant.userId === userId.

## ASSUMPTIONS
- Implemented as pure DB checks against user_participants.userId; session->userId mapping happens in the API layer (BetterAuth).
- Non-existent participant => unauthorized (false).
