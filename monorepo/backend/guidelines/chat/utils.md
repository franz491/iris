buildMessages(ChatContext): Message[]

it takes a ChatContext (usually returned as an api response from the AI) and decomposes it following these rules:
1. all thoughts until an output are concatenated using \n\n
2. subsequent thoughts are added to the subsequent outputs in a different Message object
3. if no output is found after thoughts, the message is left as "" - the frontend will display *empty message*
4. everything is returned in an array, properly ordered.

## ASSUMPTIONS
- Signature adapted: buildMessages decomposes assistant entries of a ChatContext into draft Messages (without ids/chatId/authorId); thoughts before an output attach to that output, trailing thoughts keep empty content. Added collectStream()/newMessageId() helpers.
