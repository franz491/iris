// tests/providers.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Address } from "../src/net/pinned-http.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "iris-prov-"));
  process.env.IRIS_DATA_DIR = dir;
  vi.resetModules();
});

describe("files provider", () => {
  async function make() {
    const { FilesProvider } = await import("../src/providers/installed/files.js");
    const p = new FilesProvider();
    const root = path.join(dir, "files");
    await p.setConfig({
      name: "files",
      activeFunctionalities: ["create_file", "read_file", "edit_file", "search_and_replace", "edit_lines", "shell"],
      additionalSettings: { rootFolder: root, dockerExecutable: "true" },
    });
    return { p, root };
  }

  it("creates and reads files", async () => {
    const { p, root } = await make();
    await p.callFunctionality("create_file", { filename: "a/b.txt", content: "hello world" });
    const r = (await p.callFunctionality("read_file", { filename: "a/b.txt" })) as { content: string };
    expect(r.content).toBe("hello world");
    expect(existsSync(path.join(root, "a/b.txt"))).toBe(true);
  });

  it("round-trips binary files as base64", async () => {
    const { p } = await make();
    const bytes = Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff]);
    await p.callFunctionality("create_file", {
      filename: "pic.bin",
      content: bytes.toString("base64"),
      encoding: "base64",
    });
    const read = (await p.callFunctionality("read_file", {
      filename: "pic.bin",
      encoding: "base64",
    })) as { content: string; encoding: string };
    expect(Buffer.from(read.content, "base64")).toEqual(bytes);
    expect(read.encoding).toBe("base64");
  });

  it("promotes bounded streams atomically without overwriting", async () => {
    const { p, root } = await make();
    async function* chunks() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
    }
    await p.createFileFromStream("stream.bin", chunks(), 4);
    expect(await (await import("node:fs/promises")).readFile(path.join(root, "stream.bin"))).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
    expect(readdirSync(root).filter((name) => name.includes(".upload-")).length).toBe(0);

    await expect(p.createFileFromStream("stream.bin", chunks(), 4)).rejects.toThrow(/already exists|conflict/);
    expect(await (await import("node:fs/promises")).readFile(path.join(root, "stream.bin"))).toEqual(
      Buffer.from([1, 2, 3, 4]),
    );
  });

  it("cleans provider temp files on stream overflow or source failure", async () => {
    const { p, root } = await make();
    async function* overflowing() {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4]);
    }
    await expect(p.createFileFromStream("overflow.bin", overflowing(), 3)).rejects.toThrow(/exceeds/);
    expect(existsSync(path.join(root, "overflow.bin"))).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes(".upload-")).length).toBe(0);

    async function* failing() {
      yield new Uint8Array([1]);
      const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      throw error;
    }
    await expect(p.createFileFromStream("failed.bin", failing(), 3)).rejects.toThrow("disk full");
    expect(existsSync(path.join(root, "failed.bin"))).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes(".upload-")).length).toBe(0);
  });

  it("rejects path escapes and symlink traversal", async () => {
    const { p } = await make();
    await expect(p.callFunctionality("create_file", { filename: "../evil.txt" })).rejects.toThrow();
    await expect(p.callFunctionality("create_file", { filename: "/etc/passwd" })).rejects.toThrow();
    // symlink
    const { p: p2, root } = await make();
    const { symlinkSync, mkdirSync } = await import("node:fs");
    mkdirSync(path.join(root, "sub"), { recursive: true });
    try {
      symlinkSync("/etc", path.join(root, "sub", "link"));
    } catch {
      /* may fail on some platforms */
    }
    await expect(p2.callFunctionality("read_file", { filename: "sub/link/passwd" })).rejects.toThrow();
  });

  it("edit_file errors on multiple matches", async () => {
    const { p } = await make();
    await p.callFunctionality("create_file", { filename: "f.txt", content: "x\nx" });
    await expect(p.callFunctionality("edit_file", { filename: "f.txt", before: "x", after: "y" })).rejects.toThrow(
      /wider/,
    );
    await p.callFunctionality("edit_file", { filename: "f.txt", before: "x\nx", after: "y\nz" });
    const r = (await p.callFunctionality("read_file", { filename: "f.txt", show_line_numbers: true })) as {
      content: string;
    };
    expect(r.content).toBe("1: y\n2: z");
  });

  it("search_and_replace with regex groups", async () => {
    const { p } = await make();
    await p.callFunctionality("create_file", { filename: "s.txt", content: "foo bar" });
    await p.callFunctionality("search_and_replace", {
      filename: "s.txt",
      pattern: "(foo) (bar)",
      substitution: "$2 $1",
    });
    const r = (await p.callFunctionality("read_file", { filename: "s.txt" })) as { content: string };
    expect(r.content).toBe("bar foo");
  });

  it("inactive functionality is refused", async () => {
    const { FilesProvider } = await import("../src/providers/installed/files.js");
    const p = new FilesProvider();
    await p.setConfig({
      name: "files",
      activeFunctionalities: [],
      additionalSettings: { rootFolder: path.join(dir, "f2") },
    });
    await expect(p.callFunctionality("read_file", { filename: "x" })).rejects.toThrow(/not active/);
  });
});

describe("docs provider", () => {
  async function make() {
    const { DocsProvider } = await import("../src/providers/installed/docs.js");
    const p = new DocsProvider();
    const docs = path.join(dir, "docs");
    const { mkdirSync, writeFileSync: wf } = await import("node:fs");
    mkdirSync(path.join(docs, "react"), { recursive: true });
    wf(path.join(docs, "react/intro.md"), "React is a library\nfor building UIs");
    await p.setConfig({
      name: "docs",
      activeFunctionalities: ["list_docs", "read_structure", "read_file", "search", "search_regex"],
      additionalSettings: { docsFolder: docs },
    });
    return p;
  }

  it("lists docs and reads files", async () => {
    const p = await make();
    const l = (await p.callFunctionality("list_docs", {})) as { docs: string[] };
    expect(l.docs).toContain("react");
    const r = (await p.callFunctionality("read_file", { topic: "react", file_path: "intro.md" })) as {
      content: string;
    };
    expect(r.content).toContain("React is a library");
  });

  it("search is case-insensitive; traversal rejected", async () => {
    const p = await make();
    const s = (await p.callFunctionality("search", { query: "LIBRARY", topic: "react" })) as { results: string };
    expect(s.results).toContain("React is a library");
    await expect(p.callFunctionality("read_file", { topic: "../etc", file_path: "passwd" })).rejects.toThrow();
    await expect(p.callFunctionality("read_file", { topic: "react", file_path: "../../x" })).rejects.toThrow();
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("search provider", () => {
  it("drops malformed remote links and bounds result fields", async () => {
    const { parseResults } = await import("../src/providers/installed/search.js");
    const html = `<a class="result__a" href="javascript:alert(1)">bad</a><a class="result__a" href="https://safe.example">${"x".repeat(3000)}</a>`;
    const results = parseResults(html, 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://safe.example/");
    expect(results[0]?.title).toHaveLength(2000);
  });

  it("uses the pinned bounded transport", async () => {
    const net = await import("../src/net/pinned-http.js");
    net.setPinnedResolverForTests(async () => [{ address: "203.0.113.10", family: 4 }]);
    const requestMock = vi.fn(
      async (_url: URL, _address: Address, _signal: AbortSignal, _init: RequestInit, _maxBytes: number) =>
        new Response('<a class="result__a" href="https://example.com">Example</a>'),
    );
    net.setPinnedRequestForTests(requestMock);
    const { SearchProvider } = await import("../src/providers/installed/search.js");
    const provider = new SearchProvider();
    await provider.setConfig({ name: "search", activeFunctionalities: ["search"], additionalSettings: {} });
    const result = (await provider.callFunctionality("search", { query: "iris", limit: 1 })) as { results: unknown[] };
    expect(result.results).toHaveLength(1);
    expect(requestMock.mock.calls[0]?.[0].hostname).toBe("html.duckduckgo.com");
    expect(requestMock.mock.calls[0]?.[4]).toBe(2 * 1024 * 1024);
  });

  it("parses results from duckduckgo (live, best-effort)", async () => {
    const { SearchProvider } = await import("../src/providers/installed/search.js");
    const p = new SearchProvider();
    await p.setConfig({ name: "search", activeFunctionalities: ["search"], additionalSettings: {} });
    try {
      const r = (await p.callFunctionality("search", { query: "llama.cpp", limit: 3 })) as {
        results: { title: string; url: string }[];
      };
      expect(Array.isArray(r.results)).toBe(true);
    } catch (e) {
      // network-dependent: only fail if the error isn't network-related
      const msg = String(e);
      if (!/fetch|network|abort|ENOTFOUND|search failed/i.test(msg)) throw e;
      console.warn("search live test skipped (no network)");
    }
  }, 30000);
});

describe("tts provider", () => {
  it("returns generated WAV bytes as an internal transient-audio handoff", async () => {
    const wav = Buffer.alloc(48);
    wav.write("RIFF", 0, "ascii");
    const net = await import("../src/net/pinned-http.js");
    net.setPinnedResolverForTests(async () => [{ address: "203.0.113.8", family: 4 }]);
    const requestMock = vi.fn(
      async (_url: URL, _address: Address, _signal: AbortSignal, _init: RequestInit, _maxBytes: number) =>
        new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } }),
    );
    net.setPinnedRequestForTests(requestMock);
    const { TtsProvider } = await import("../src/providers/installed/tts.js");
    const provider = new TtsProvider();
    await provider.setConfig({
      name: "tts",
      activeFunctionalities: ["synthesize"],
      additionalSettings: { baseUrl: "http://tts.test", bearerToken: "secret", model: "pocket-tts" },
    });
    const result = (await provider.callFunctionality("synthesize", {
      text: "hello",
      language: "English",
      chatId: "chat-1",
    })) as { _irisAudio: { base64: string } };
    expect(Buffer.from(result._irisAudio.base64, "base64")).toEqual(wav);
    expect(requestMock.mock.calls[0]?.[0].href).toBe("http://tts.test/v1/audio/speech");
    expect(requestMock.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
      }),
    );
    expect(JSON.parse(String(requestMock.mock.calls[0]?.[3].body))).toMatchObject({ model: "pocket-tts" });
  });

  it("rejects non-WAV responses", async () => {
    const net = await import("../src/net/pinned-http.js");
    net.setPinnedRequestForTests(async () => new Response("not audio"));
    const { TtsProvider } = await import("../src/providers/installed/tts.js");
    const provider = new TtsProvider();
    await provider.setConfig({ name: "tts", activeFunctionalities: ["synthesize"], additionalSettings: {} });
    await expect(provider.callFunctionality("synthesize", { text: "hello", chatId: "chat-1" })).rejects.toThrow(
      /valid-sized WAV/,
    );
  });
});
