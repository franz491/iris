import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "iris-startup-performance-"));
  process.env.IRIS_DATA_DIR = dataDir;
  vi.resetModules();
});

describe("startup performance contract", () => {
  it("initializes a bounded provider set exactly once without network work", async () => {
    const total = 64;
    const names = Array.from({ length: total }, (_, i) => `fixture_${String(i).padStart(3, "0")}`);
    writeFileSync(
      path.join(dataDir, "config.yaml"),
      names.map((name) => `${name}:\n  activeFunctionalities: []\n`).join(""),
    );

    const { registerProviderFactory } = await import("../src/runtime/kernel.js");
    const initialized: string[] = [];
    for (const name of names) {
      registerProviderFactory(name, () => ({
        providerDescriptor: { name, description: "fixture", options: [] },
        async setConfig() {
          initialized.push(name);
        },
        async callFunctionality() {
          throw new Error("fixture provider has no functionality");
        },
      }));
    }

    const { kernel } = await import("../src/runtime/kernel.js");
    await kernel.start();

    expect(initialized).toHaveLength(total);
    expect(new Set(initialized)).toEqual(new Set(names));
    expect({ configured: total, providerInitializations: initialized.length, networkCalls: 0 }).toEqual({
      configured: 64,
      providerInitializations: 64,
      networkCalls: 0,
    });
    for (const name of names) expect(kernel.getStatus(name)).toBeDefined();
  });
});
