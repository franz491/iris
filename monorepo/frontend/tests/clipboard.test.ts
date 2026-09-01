import { describe, expect, it } from "vitest";
import { pastedImage } from "../src/lib/clipboard";

describe("clipboard images", () => {
  it("extracts an image file with a recognized extension", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
    const data = {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
    } as unknown as DataTransfer;
    expect(pastedImage(data, 123)).toEqual({ file, filename: "pasted-image-123.png" });
  });

  it("ignores text-only clipboard data", () => {
    const data = {
      items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
    } as unknown as DataTransfer;
    expect(pastedImage(data)).toBeNull();
  });
});
