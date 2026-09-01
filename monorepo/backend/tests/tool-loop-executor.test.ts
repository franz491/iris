import { describe, expect, it, vi } from "vitest";
import { executeToolCall } from "../src/chat/tool-loop-executor.js";
import type { ToolCallRequest } from "../src/chat/tools.js";

const signal = new AbortController().signal;

describe("tool-loop executor", () => {
  it("dispatches read_tool_info through its injected handler", async () => {
    const handleReadToolInfo = vi.fn(async (args: string) => ({ args }));
    const requestFrontendTool = vi.fn();
    const executeProviderTool = vi.fn();
    await expect(
      executeToolCall({ name: "read_tool_info", arguments: '{"name":"read_tool_info"}' }, signal, {
        config: { tools: [] },
        handleReadToolInfo,
        requestFrontendTool,
        executeProviderTool,
      }),
    ).resolves.toEqual({ args: '{"name":"read_tool_info"}' });
    expect(handleReadToolInfo).toHaveBeenCalledOnce();
    expect(requestFrontendTool).not.toHaveBeenCalled();
    expect(executeProviderTool).not.toHaveBeenCalled();
  });

  it("dispatches an enabled frontend function and preserves the signal", async () => {
    const requestFrontendTool = vi.fn(async (call: ToolCallRequest, receivedSignal: AbortSignal) => ({
      name: call.name,
      aborted: receivedSignal.aborted,
    }));
    const deps = {
      config: { tools: [{ tool: "fe_files" }] },
      handleReadToolInfo: async () => ({}),
      requestFrontendTool,
      executeProviderTool: vi.fn(),
    };
    await expect(executeToolCall({ name: "create_file", arguments: "{}" }, signal, deps)).resolves.toEqual({
      name: "create_file",
      aborted: false,
    });
    expect(requestFrontendTool).toHaveBeenCalledOnce();
    expect(deps.executeProviderTool).not.toHaveBeenCalled();
  });

  it("returns a stable error for unknown or inactive functions", async () => {
    const deps = {
      config: { tools: [] },
      handleReadToolInfo: async () => ({}),
      requestFrontendTool: vi.fn(),
      executeProviderTool: vi.fn(),
    };
    await expect(executeToolCall({ name: "not_a_tool", arguments: "{}" }, signal, deps)).resolves.toEqual({
      error: "The tool specified does not exist or isn't active in this chat",
    });
    expect(deps.requestFrontendTool).not.toHaveBeenCalled();
    expect(deps.executeProviderTool).not.toHaveBeenCalled();
  });

  it("sanitizes provider errors while preserving the executor result contract", async () => {
    const deps = {
      config: { tools: [{ tool: "files" }] },
      handleReadToolInfo: async () => ({}),
      requestFrontendTool: vi.fn(),
      executeProviderTool: vi.fn(async () => {
        throw new Error("cannot access /tmp/files/private.txt");
      }),
    };
    await expect(executeToolCall({ name: "backend_create_file", arguments: "{}" }, signal, deps)).resolves.toEqual({
      error: "cannot access /sandbox/private.txt",
    });
  });
});
