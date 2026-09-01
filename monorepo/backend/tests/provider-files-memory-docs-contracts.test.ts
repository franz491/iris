import { describe, expect, it } from "vitest";
import { parseProviderContract } from "../src/providers/contracts.js";
import { FilesProvider } from "../src/providers/installed/files.js";
import { MemoryProvider } from "../src/providers/installed/memory.js";
import { DocsProvider } from "../src/providers/installed/docs.js";

const valid: Array<[string, unknown]> = [
  ["files.create_file", { ok: true }],
  ["files.read_file", { content: "hello", encoding: "utf8" }],
  ["files.delete_file", { ok: true }],
  ["files.search_and_replace", { ok: true }],
  ["files.edit_file", { ok: true }],
  ["files.edit_lines", { ok: true }],
  ["memory.list_keywords", { keywords: ["name", "preference"] }],
  [
    "memory.list_memories",
    {
      memories: [
        { id: "m1", keywords: ["name"], content: "Ada", createdAt: "2026-01-01T00:00:00.000Z", isPrivate: false },
      ],
    },
  ],
  ["memory.add_memory", { ok: true, id: "m1", keywords: ["name"], hint: "call list_keywords" }],
  ["memory.remove_memory", { ok: true }],
  ["docs.list_docs", { docs: ["react", "typescript"] }],
  ["docs.read_structure", { structure: "components/" }],
  ["docs.read_file", { content: "# Topic" }],
  ["docs.search", { results: "guide.md:1: topic" }],
  ["docs.search_regex", { results: "guide.md:1: topic" }],
  ["files.shell", { stdout: "ok", stderr: "" }],
  ["audio.refresh_devices", { devices: [{ id: "default", name: "Default", direction: "out" }] }],
  ["audio.stream_audio", { ok: true }],
  ["audio.read_audio", { kind: "audio_stream", version: 1 }],
  ["admin-setup.list_sections", ["server", "services"]],
  ["admin-setup.read_section", { enabled: true }],
  ["admin-setup.get_options", { modes: ["connect-only"] }],
  ["admin-setup.propose_patch", { id: "patch-1", status: "staged" }],
  ["admin-setup.validate_patch", { id: "patch-1", status: "tested" }],
  ["search.search", { results: [{ title: "Iris", url: "https://example.com/", snippet: "docs" }] }],
  ["shell.shell_oneshot", { code: 0, stdout: "ok", stderr: "", cwd: "/sandbox" }],
  ["shell.shell_interactive", { kind: "interactive_session", version: 1, sessionId: "session-1" }],
];

describe("implemented files, memory, and docs provider contracts", () => {
  it.each(valid)("accepts the %s implementation result", (key, value) => {
    expect(() => parseProviderContract(key as never, value)).not.toThrow();
  });

  it.each(valid)("rejects malformed %s implementation results", (key, value) => {
    const malformed = key.startsWith("admin-setup")
      ? null
      : { ...(value as Record<string, unknown>), unexpected: true };
    expect(() => parseProviderContract(key as never, malformed)).toThrow();
  });

  it("rejects wrong nested output types and unbounded file content", () => {
    expect(() => parseProviderContract("memory.list_memories", { memories: [{ id: 1 }] })).toThrow();
    expect(() => parseProviderContract("docs.search", { results: "x".repeat(262_145) })).toThrow();
    expect(() => parseProviderContract("files.read_file", { content: "x", encoding: "binary" })).toThrow();
    expect(() =>
      parseProviderContract("audio.refresh_devices", { devices: [{ id: "x", name: "x", direction: "sideways" }] }),
    ).toThrow();
    expect(() =>
      parseProviderContract("search.search", { results: [{ title: "x", url: "not-a-url", snippet: "" }] }),
    ).toThrow();
    expect(() =>
      parseProviderContract("shell.shell_interactive", { kind: "session", version: 1, sessionId: "x" }),
    ).toThrow();
  });

  it("publishes the same bounded return contracts in provider descriptors", () => {
    for (const provider of [new FilesProvider(), new MemoryProvider(), new DocsProvider()]) {
      for (const option of provider.providerDescriptor.options) {
        if (option.name === "shell") continue;
        expect(Object.keys(option.returnSchema)).not.toHaveLength(0);
      }
    }
  });
});
