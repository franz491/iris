import { describe, expect, it } from "vitest";
import { validateAttachmentSignature, processAttachmentUpload } from "../src/api/files.js";

describe("attachment content signatures", () => {
  it("accepts valid PNG and WAV headers", () => {
    expect(() =>
      validateAttachmentSignature("x.png", Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), "image/png"),
    ).not.toThrow();
    const wav = new Uint8Array(12);
    wav.set([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WAVE")]);
    expect(() => validateAttachmentSignature("x.wav", wav, "audio/wav")).not.toThrow();
  });
  it("rejects mismatched MIME and corrupt headers", () => {
    expect(() => validateAttachmentSignature("x.png", new Uint8Array(8), "image/png")).toThrow(/content/);
    expect(() => validateAttachmentSignature("x.jpg", Uint8Array.from([255, 216, 255]), "image/png")).toThrow(/MIME/);
  });
  it("validates before persistence", async () => {
    let calls = 0;
    await expect(
      processAttachmentUpload("x.png", new Uint8Array(8), "image/png", async () => {
        calls++;
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    await processAttachmentUpload(
      "x.png",
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      "IMAGE/PNG; charset=binary".split(";", 1)[0],
      async () => {
        calls++;
      },
    );
    expect(calls).toBe(1);
  });
});
