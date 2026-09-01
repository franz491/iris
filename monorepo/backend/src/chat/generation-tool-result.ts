import type { NewMessage } from "./message-service.js";
import type { Message } from "./types.js";

export interface ToolResultPersistenceDeps {
  persist: (message: NewMessage) => Promise<Message>;
}

/** Build the bounded persisted representation of one provider/tool result. */
export function toolResultMessage(chatId: string, authorId: string, toolName: string, result: unknown): NewMessage {
  return {
    chatId,
    authorId,
    type: "tool_result",
    thought: "",
    content: JSON.stringify({ tool: toolName, result }).slice(0, 16_000),
    to: undefined,
  };
}

/** Persist a tool result without changing the surrounding generation state machine. */
export function persistToolResult(
  chatId: string,
  authorId: string,
  toolName: string,
  result: unknown,
  deps: ToolResultPersistenceDeps,
): Promise<Message> {
  return deps.persist(toolResultMessage(chatId, authorId, toolName, result));
}
