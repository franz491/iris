Chat

sendMessage(message: Message, chat: Chat): Promise<void>

editHistory(oldMessage: MessageId, newMessage: Message): Promise<void>

getParticipants(): Promise<ChatParticipant<"ai"|"user"[]>

subscribe(stream: "reasoning"|"output", function): function

getMessagesSinceId(participantId: ParticipantId, lastMessage: MessageId): Promise<Message[]>
