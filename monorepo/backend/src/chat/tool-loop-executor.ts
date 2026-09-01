import { parseToolCalls, type ToolCallRequest, type ToolConfig } from "./tools.js";

export interface ToolLoopExecutorDeps {
  config: ToolConfig;
  handleReadToolInfo: (rawArguments: string) => Promise<unknown>;
  requestFrontendTool: (call: ToolCallRequest, signal: AbortSignal) => Promise<unknown>;
  executeProviderTool: (call: ToolCallRequest) => Promise<unknown>;
}

/** Dispatch one model tool call; loop state and result publication stay with ChatInstance. */
export async function executeToolCall(
  raw: { name: string; arguments: string },
  signal: AbortSignal,
  deps: ToolLoopExecutorDeps,
): Promise<unknown> {
  if (raw.name === "read_tool_info") return deps.handleReadToolInfo(raw.arguments);

  const calls = parseToolCalls([raw], deps.config);
  if (calls.length === 0) return { error: "The tool specified does not exist or isn't active in this chat" };
  const call = calls[0];
  if (call.groupDef.flavor === "frontend") return deps.requestFrontendTool(call, signal);

  try {
    return await deps.executeProviderTool(call);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message.replace(/[^\s]*\/files\//g, "/sandbox/") };
  }
}
