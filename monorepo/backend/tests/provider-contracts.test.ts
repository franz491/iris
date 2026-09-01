import { describe, expect, it } from "vitest";
import { parseProviderContract } from "../src/providers/contracts.js";

describe("provider functionality contracts", () => {
  it.each([
    ["models.list", { data: [{ id: "model" }] }, { data: [{ id: 42 }] }],
    ["files.read_file", { content: "YQ==", encoding: "base64" }, { content: 42, encoding: "base64" }],
    ["tts.synthesize", { _irisAudio: { base64: "YQ==" } }, { _irisAudio: { base64: 42 } }],
  ])("parses valid and rejects malformed %s", (key, valid, malformed) => {
    expect(() => parseProviderContract(key as never, valid)).not.toThrow();
    expect(() => parseProviderContract(key as never, malformed)).toThrow();
  });

  it("parses valid file and audio results", () => {
    expect(parseProviderContract("files.read_file", { content: "YQ==", encoding: "base64" }).encoding).toBe("base64");
    expect(
      parseProviderContract("tts.synthesize", { _irisAudio: { base64: "YQ==", mimeType: "audio/wav" } })._irisAudio
        ?.mimeType,
    ).toBe("audio/wav");
  });
  it("rejects malformed and oversized contract fields", () => {
    expect(() => parseProviderContract("files.read_file", { content: "x", encoding: "binary" })).toThrow();
    expect(() => parseProviderContract("files.read_file", { content: "not base64!", encoding: "base64" })).toThrow();
    expect(() =>
      parseProviderContract("files.read_file", { content: "x".repeat(14 * 1024 * 1024 + 1), encoding: "utf8" }),
    ).toThrow();
    expect(() =>
      parseProviderContract("files.read_file", { content: "A".repeat(14 * 1024 * 1024 + 1), encoding: "base64" }),
    ).toThrow();
    expect(() =>
      parseProviderContract("tts.synthesize", { _irisAudio: { base64: "x", mimeType: "m".repeat(129) } }),
    ).toThrow();
    expect(() =>
      parseProviderContract("tts.synthesize", { _irisAudio: { base64: "x".repeat(14 * 1024 * 1024 + 1) } }),
    ).toThrow();
  });
  it("accepts swappable implementations through the same normalized contracts", () => {
    const fakeA = { list: () => ({ data: [{ id: "alpha" }] }), read: () => ({ content: "YQ==", encoding: "base64" }) };
    const fakeB = { list: () => ({ data: [{ id: "beta" }] }), read: () => ({ content: "Yg==", encoding: "base64" }) };
    for (const fake of [fakeA, fakeB]) {
      expect(parseProviderContract("models.list", fake.list()).data[0].id).toMatch(/^(alpha|beta)$/);
      expect(parseProviderContract("files.read_file", fake.read()).encoding).toBe("base64");
    }
    expect(() => parseProviderContract("models.list", { data: [{ id: "bad\nvalue" }] })).toThrow();
  });
});
