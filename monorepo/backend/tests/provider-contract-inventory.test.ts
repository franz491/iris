import { describe, expect, it } from "vitest";
import { providerContracts } from "../src/providers/contracts.js";

describe("built-in provider contract inventory", () => {
  it("declares every built-in functionality at the contract boundary", () => {
    const expected = [
      "files.create_file",
      "files.read_file",
      "files.delete_file",
      "files.search_and_replace",
      "files.edit_file",
      "files.edit_lines",
      "files.shell",
      "tts.synthesize",
      "memory.list_keywords",
      "memory.list_memories",
      "memory.add_memory",
      "memory.remove_memory",
      "docs.list_docs",
      "docs.read_structure",
      "docs.read_file",
      "docs.search",
      "docs.search_regex",
      "audio.refresh_devices",
      "audio.stream_audio",
      "audio.read_audio",
      "admin-setup.list_sections",
      "admin-setup.read_section",
      "admin-setup.get_options",
      "admin-setup.propose_patch",
      "admin-setup.validate_patch",
      "search.search",
      "shell.shell_oneshot",
      "shell.shell_interactive",
    ];
    expect(Object.keys(providerContracts)).toEqual(expect.arrayContaining(expected));
  });
});
