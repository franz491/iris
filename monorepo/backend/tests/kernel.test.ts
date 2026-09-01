// tests/kernel.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-kern-"));
  vi.resetModules();
});

describe("kernel + providers integration", () => {
  it("starts configured providers and routes requests", async () => {
    writeFileSync(
      path.join(process.env.IRIS_DATA_DIR!, "config.yaml"),
      `files:
  activeFunctionalities: [create_file, read_file]
  additionalSettings:
    rootFolder: ${path.join(process.env.IRIS_DATA_DIR!, "files")}
docs:
  activeFunctionalities: []
`,
    );
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    registerInstalledProviders();
    const { kernel } = await import("../src/runtime/kernel.js");
    await kernel.start();

    expect(kernel.getStatus("files")).toBeDefined();
    await kernel.sendRequest({
      provider: "files",
      functionality: "create_file",
      kwargs: { filename: "k.txt", content: "hi" },
    });
    const r = await kernel.useProvider<string>("files", "read_file", { filename: "k.txt" });
    expect((r as { content: string }).content).toBe("hi");

    // unknown provider/functionality errors
    await expect(kernel.useProvider("files", "shell", {})).rejects.toThrow();
    expect(() => kernel.getStatus("nonexistent")).toThrow();
  });

  it("setConfig reconfigures a provider (functionality gating)", async () => {
    const { registerInstalledProviders } = await import("../src/providers/installed/index.js");
    registerInstalledProviders();
    const { kernel } = await import("../src/runtime/kernel.js");
    const root = path.join(process.env.IRIS_DATA_DIR!, "f");
    await kernel.setConfig([
      { name: "files", activeFunctionalities: ["create_file"], additionalSettings: { rootFolder: root } },
    ]);
    await kernel.sendRequest({
      provider: "files",
      functionality: "create_file",
      kwargs: { filename: "a.txt", content: "x" },
    });
    // read_file not active -> error
    await expect(
      kernel.sendRequest({ provider: "files", functionality: "read_file", kwargs: { filename: "a.txt" } }),
    ).rejects.toThrow();
    // now enable
    await kernel.setConfig([
      { name: "files", activeFunctionalities: ["read_file"], additionalSettings: { rootFolder: root } },
    ]);
    const r = await kernel.sendRequest({
      provider: "files",
      functionality: "read_file",
      kwargs: { filename: "a.txt" },
    });
    expect((r as { content: string }).content).toBe("x");
  });
});
