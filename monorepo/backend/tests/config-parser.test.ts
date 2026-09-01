// tests/config-parser.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "iris-cfg-"));
  process.env.IRIS_DATA_DIR = dir;
  // re-import module fresh per test
});

async function load() {
  const m = await import("../src/runtime/config-parser.js");
  return m;
}

describe("config parser", () => {
  it("bootstraps from yaml and reads back configs", async () => {
    const yamlPath = path.join(dir, "config.yaml");
    writeFileSync(
      yamlPath,
      ["files:", "  activeFunctionalities: [read_file]", "  additionalSettings:", "    rootFolder: files/"].join("\n"),
    );
    const cp = await load();
    const cfg = await cp.getConfig(yamlPath);
    expect(cfg.files.activeFunctionalities).toEqual(["read_file"]);
    expect(cfg.files.additionalSettings.rootFolder).toBe("files/");
  });

  it("setConfig persists and getConfig returns single provider", async () => {
    const yamlPath = path.join(dir, "config.yaml");
    writeFileSync(yamlPath, "docs:\n  activeFunctionalities: []\n");
    const cp = await load();
    await cp.setConfig("files", { name: "files", activeFunctionalities: ["read_file"], additionalSettings: {} });
    const one = await cp.getConfig(undefined, "files");
    expect(Object.keys(one)).toEqual(["files"]);
    // yaml-only provider not in DB until bootstrap ran
    const outPath = await cp.exportConfig(path.join(dir, "export.yaml"));
    expect(outPath.endsWith("export.yaml")).toBe(true);
  });

  it("redacts legacy secrets in exported configuration", async () => {
    const cp = await load();
    await cp.setConfig("provider", {
      name: "provider",
      activeFunctionalities: [],
      additionalSettings: { apiKey: "legacy-secret", nested: { password: "pw" } },
    });
    const outPath = await cp.exportConfig(path.join(dir, "export.yaml"));
    const exported = await import("node:fs/promises").then(({ readFile }) => readFile(outPath, "utf8"));
    expect(exported).not.toContain("legacy-secret");
    expect(exported).not.toContain("pw");
    expect(exported).toContain("configured");
  });
});
