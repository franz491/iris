import type { ChatContext } from "./types.js";

export interface GenerationToolCall {
  name: string;
  arguments: string;
}

export interface ToolCallContextExchange {
  context: ChatContext;
  callIds: string[];
}

/** Append the provider-native assistant tool-call exchange without mutating prior context. */
export function appendAssistantToolCalls(
  context: ChatContext,
  participantId: string,
  iteration: number,
  toolCalls: readonly GenerationToolCall[],
): ToolCallContextExchange {
  const callIds = toolCalls.map((_, index) => `iris-loop-${participantId}-${iteration}-${index}`);
  return {
    callIds,
    context: [
      ...context,
      {
        role: "assistant",
        content: null,
        tool_calls: toolCalls.map((call, index) => ({
          id: callIds[index],
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      },
    ],
  };
}

/** Append one bounded provider-native tool result without exposing an unbounded result value. */
export function appendToolResult(context: ChatContext, callId: string, result: unknown): ChatContext {
  return [
    ...context,
    {
      role: "tool",
      tool_call_id: callId,
      content: JSON.stringify(result).slice(0, 8_000),
    },
  ];
}
