import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-files-response-"));
  vi.resetModules();
});

describe("file provider response boundary", () => {
  it("accepts only the base64 read shape", async () => {
    const { parseFileReadResult } = await import("../src/api/files.js");
    expect(parseFileReadResult({ content: "AQI=", encoding: "base64" })).toEqual({
      content: "AQI=",
      encoding: "base64",
    });
    expect(() => parseFileReadResult({ content: 42, encoding: "base64" })).toThrow("invalid response");
    expect(() => parseFileReadResult({ content: "AQI=", encoding: "utf8" })).toThrow("invalid response");
  });
});
