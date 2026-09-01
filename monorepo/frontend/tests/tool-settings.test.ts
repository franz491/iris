// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advertisedToolConfig,
  effectiveToolConfig,
  fetchToolCatalog,
  getChatOverride,
  getMachineDefaults,
  getPromptOverrides,
  setChatOverride,
} from "../src/lib/tools";
import {
  setupDialogAccessibility,
  setupNestedDialogAccessibility,
  validateImportedToolConfig,
} from "../src/components/ToolSettingsModal.svelte";

beforeEach(() => localStorage.clear());

describe("local tool settings", () => {
  it("accepts a valid server tool catalog", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            groups: [
              {
                name: "fe_files",
                flavor: "frontend",
                alwaysLoaded: false,
                editable: true,
                toolDoc: "Files",
                functions: { read_file: { doc: "Read a file" } },
              },
            ],
          }),
        ),
      ),
    );
    await expect(fetchToolCatalog("catalog-valid")).resolves.toMatchObject([{ name: "fe_files" }]);
  });

  it("falls back to the local catalog for malformed or failed responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ groups: "bad" }), { status: 200 })));
    await expect(fetchToolCatalog("catalog-malformed")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "fe_files" })]),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(fetchToolCatalog("catalog-error")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "fe_files" })]),
    );
  });

  it("handles nested prompt Escape and restores opener focus", () => {
    const opener = document.createElement("button");
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    document.body.append(opener, dialog);
    opener.focus();
    let closed = 0;
    const cleanup = setupNestedDialogAccessibility(dialog, opener, () => {
      closed += 1;
    });
    expect(document.activeElement).toBe(dialog);
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closed).toBe(1);
    cleanup();
    expect(document.activeElement).toBe(opener);
  });
  it("establishes dialog focus, closes on Escape, and restores trigger focus", async () => {
    const trigger = document.createElement("button");
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    document.body.append(trigger, dialog);
    trigger.focus();
    let closed = 0;
    const cleanup = setupDialogAccessibility(dialog, () => {
      closed += 1;
    });
    await Promise.resolve();
    expect(document.activeElement).toBe(dialog);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closed).toBe(1);
    cleanup();
    expect(document.activeElement).toBe(trigger);
  });
  it("isolates settings by chat and user on this client", () => {
    setChatOverride("chat-1", "alice", {
      tools: [{ tool: "fe_files", settings: { rootFolder: "/alice/project" } }],
    });
    setChatOverride("chat-1", "bob", {
      tools: [{ tool: "fe_files", settings: { rootFolder: "/bob/notes" } }],
    });
    setChatOverride("chat-2", "alice", {
      tools: [{ tool: "fe_shell", settings: { workingFolder: "/alice/other", mode: "docker-user" } }],
    });

    expect(effectiveToolConfig("chat-1", "alice").tools[0].settings?.rootFolder).toBe("/alice/project");
    expect(effectiveToolConfig("chat-1", "bob").tools[0].settings?.rootFolder).toBe("/bob/notes");
    expect(effectiveToolConfig("chat-2", "alice").tools[0].tool).toBe("fe_shell");
  });

  it("advertises only tools whose required local setup is complete", () => {
    setChatOverride("chat", "alice", {
      tools: [
        { tool: "fe_files", requiresApproval: true },
        { tool: "fe_shell", settings: { workingFolder: "/work", mode: "docker-user" } },
        { tool: "fe_edit_settings", requiresApproval: true },
      ],
    });
    // happy-dom is a browser client: native tools are never advertised even
    // if configured; edit_settings remains useful for explaining setup.
    expect(advertisedToolConfig("chat", "alice").tools.map((tool) => tool.tool)).toEqual(["fe_edit_settings"]);
  });

  it("falls back when persisted tool configs are valid JSON with the wrong shape", () => {
    localStorage.setItem("iris.tools.defaults.alice", JSON.stringify({ tools: "not-an-array" }));
    localStorage.setItem("iris.tools.chat.alice.chat", JSON.stringify({ tools: [{ requiresApproval: true }] }));

    expect(getMachineDefaults("alice")).toEqual({
      tools: [{ tool: "fe_edit_settings", requiresApproval: true }],
    });
    expect(getChatOverride("chat", "alice")).toBeNull();
  });

  it("rejects malformed persisted prompt overrides", () => {
    localStorage.setItem("iris.toolPrompts.alice", JSON.stringify({ fe_files: 42 }));

    expect(getPromptOverrides("alice")).toEqual({});
  });

  it("keeps valid imported settings while skipping malformed entries", () => {
    const result = validateImportedToolConfig({
      kind: "iris.toolconfig",
      version: 3,
      tools: [
        { tool: "fe_files", requiresApproval: true, approvalTimeoutMs: 120000, settings: { rootFolder: "/work" } },
        { tool: "fe_shell", approvalTimeoutMs: -1 },
        { tool: "fe_docs", settings: { rootFolder: { unexpected: true } } },
      ],
      promptOverrides: { fe_files: "valid prompt", "fe_shell:shell_exec": 42 },
    });

    expect(result.tools).toEqual([
      {
        tool: "fe_files",
        requiresApproval: true,
        approvalTimeoutMs: 120000,
        settings: { rootFolder: "/work" },
      },
    ]);
    expect(result.promptOverrides).toEqual({ fe_files: "valid prompt" });
    expect(result.skippedTools).toBe(2);
    expect(result.skippedPromptOverrides).toBe(1);
  });

  it("rejects unsupported import envelopes and bounded overflows", () => {
    expect(() => validateImportedToolConfig({ kind: "iris.toolconfig", version: 2, tools: [] })).toThrow();
    expect(() => validateImportedToolConfig({ kind: "iris.toolconfig", version: 3, tools: "not-an-array" })).toThrow();
    expect(() =>
      validateImportedToolConfig({
        kind: "iris.toolconfig",
        version: 3,
        tools: [{ tool: "fe_files", settings: { rootFolder: "x".repeat(16_385) } }],
      }),
    ).not.toThrow();
    expect(
      validateImportedToolConfig({
        kind: "iris.toolconfig",
        version: 3,
        tools: [{ tool: "fe_files", settings: { rootFolder: "x".repeat(16_385) } }],
      }).skippedTools,
    ).toBe(1);
  });
});
