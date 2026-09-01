// all IDs are just string
// except ModelId, they're all UUIDs.

ChatContext = ChatCompletionMessageParam[] // from openai

Chat

id: ChatId
participants: Participant[]
createdAt: Date


ParticipantBase<Role extends "ai"|"user">

chatId: ChatId
role: Role
id: ParticipantId
name: string
createdAt: Date


AiParticipantBase

model: ModelId //add all fields needed to make a request, e.g. url/port/whatever
apiRouter: string
apiAdditionalFields: Record<string, unknown>
readsOthersThoughts: boolean
prompt: string
willReplyPrompt: string
lastCompactedMessageId?: MessageId
compactedContext?: string
maxContext: number


UserParticipantBase

userId?: UserId


ChatParticipant<Role extends "ai"|"user"> = {
  ParticipantBase<Role> & (
    Role extends "ai"? AiParticipantBase | UserParticipantBase
  )
}

interface Message {
  id: MessageId;
  chatId: ChatId;
  authorId: ParticipantId;
  type: "tool"|"text"|"file"|"tool_result"|"compaction"
  thought: string;
  content: string;
  createdAt: Date;
  to?: ParticipantId[] //empty means all, undefined means all
}

ChatStream {
	stream: AsyncIterable,
	recipients?: ParticipantId,
}

WillReply {
	thought?: string,
	value: boolean,
	recipients?: ParticipantId[],
	reason?: string,
}

## ASSUMPTIONS
- Fixed the malformed ChatParticipant conditional: Participant = AiParticipantBase | UserParticipantBase (discriminated union on role).
- ChatContext defined structurally (role/content/tool fields) to avoid coupling this module to an OpenAI SDK.
- Message.to: undefined OR empty array both mean "all".
