import { describe, expect, it } from "vitest";
import { audioInstallPayload, comfyInstallPayload, isImmutableCommit } from "../src/lib/audio-install";

describe("audio managed installer", () => {
  it("accepts only an immutable 40-character commit SHA", () => {
    expect(isImmutableCommit("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(isImmutableCommit("main")).toBe(false);
    expect(isImmutableCommit("0123456789abcdef0123456789abcdef0123456")).toBe(false);
    expect(isImmutableCommit(undefined)).toBe(false);
  });

  it("preserves the reviewed revision in the install payload", () => {
    expect(audioInstallPayload("cuda", "0123456789abcdef0123456789abcdef01234567")).toEqual({
      backend: "cuda",
      revision: "0123456789abcdef0123456789abcdef01234567",
    });
  });

  it("uses the reviewed revision for ComfyUI installs", () => {
    expect(comfyInstallPayload("0123456789abcdef0123456789abcdef01234567")).toEqual({
      revision: "0123456789abcdef0123456789abcdef01234567",
    });
  });
});
