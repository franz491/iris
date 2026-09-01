import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "iris-file-performance-"));
});

describe("file transfer performance contract", () => {
  it("round-trips a bounded binary payload in deterministic chunks", async () => {
    const { FilesProvider } = await import("../src/providers/installed/files.js");
    const provider = new FilesProvider();
    const root = path.join(dataDir, "files");
    await provider.setConfig({
      name: "files",
      activeFunctionalities: ["create_file", "read_file"],
      additionalSettings: { rootFolder: root },
    });

    const payload = Buffer.alloc(196_625);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) % 256;
    const chunkBytes = 64 * 1024;
    const dataChunks = Math.ceil(payload.length / chunkBytes);

    await provider.callFunctionality("create_file", {
      filename: "fixture.bin",
      content: payload.toString("base64"),
      encoding: "base64",
    });
    const result = (await provider.callFunctionality("read_file", {
      filename: "fixture.bin",
      encoding: "base64",
      max_bytes: payload.length,
    })) as { content: string; encoding: string };

    expect(result.encoding).toBe("base64");
    expect(Buffer.from(result.content, "base64")).toEqual(payload);
    expect({ bytes: payload.length, dataChunks, operations: 2 }).toEqual({
      bytes: 196_625,
      dataChunks: 4,
      operations: 2,
    });
    await expect(
      provider.callFunctionality("read_file", {
        filename: "fixture.bin",
        encoding: "base64",
        max_bytes: payload.length - 1,
      }),
    ).rejects.toThrow(/exceeds/);
  });
});
