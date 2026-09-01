import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-audio-metadata-"));
  vi.resetModules();
});

function audioCppPath(relativePath: string): string {
  return path.join(process.env.IRIS_DATA_DIR!, "software", "audio.cpp", relativePath);
}

function writeMetadata(relativePath: string, value: string): void {
  const file = audioCppPath(relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, value);
}

describe("admin audio metadata", () => {
  it("preserves valid family and aggregate metadata", async () => {
    writeMetadata("model_specs/whisper.json", JSON.stringify({ name: "Whisper", languages: ["en"] }));
    writeMetadata("webui/configs/model_params.json", JSON.stringify({ whisper: { context: 4096 } }));
    writeMetadata("webui/configs/models_catalog.json", JSON.stringify([{ id: "whisper-small" }]));

    const { audioFamilyMetadata } = await import("../src/admin/audio-metadata.js");
    expect(audioFamilyMetadata("whisper")).toEqual({ name: "Whisper", languages: ["en"] });
    expect(audioFamilyMetadata()).toEqual({
      families: { whisper: { context: 4096 } },
      models: [{ id: "whisper-small" }],
    });
  });

  it("rejects malformed and scalar metadata with safe fallbacks", async () => {
    writeMetadata("model_specs/broken.json", "{");
    writeMetadata("model_specs/scalar.json", "null");
    writeMetadata("webui/configs/model_params.json", "[]");
    writeMetadata("webui/configs/models_catalog.json", JSON.stringify({ id: "not-an-array" }));

    const { audioFamilyMetadata } = await import("../src/admin/audio-metadata.js");
    expect(audioFamilyMetadata("broken")).toEqual({ family: "broken", status: "unknown" });
    expect(audioFamilyMetadata("scalar")).toEqual({ family: "scalar", status: "unknown" });
    expect(audioFamilyMetadata()).toEqual({ families: {}, models: [] });
  });

  it("rejects metadata larger than the bounded read limit", async () => {
    writeMetadata("model_specs/large.json", JSON.stringify({ payload: "x".repeat(1024 * 1024) }));
    writeMetadata("webui/configs/model_params.json", JSON.stringify({ payload: "x".repeat(1024 * 1024) }));
    writeMetadata("webui/configs/models_catalog.json", JSON.stringify(["x".repeat(1024 * 1024)]));

    const { audioFamilyMetadata } = await import("../src/admin/audio-metadata.js");
    expect(audioFamilyMetadata("large")).toEqual({ family: "large", status: "unknown" });
    expect(audioFamilyMetadata()).toEqual({ families: {}, models: [] });
  });
});
