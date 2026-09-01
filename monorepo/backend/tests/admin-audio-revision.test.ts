import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAudioRevision, resolveComfyUiRevision, validateImmutableRevision } from "../src/admin/software.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managed audio revision resolution", () => {
  it("uses and validates IRIS_AUDIO_REVISION without network access", async () => {
    vi.stubEnv("IRIS_AUDIO_REVISION", SHA.toUpperCase());
    const fetcher = vi.fn();
    await expect(resolveAudioRevision(fetcher)).resolves.toBe(SHA);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves a valid main commit response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ sha: SHA }), { status: 200 }));
    await expect(resolveAudioRevision(fetcher)).resolves.toBe(SHA);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.github.com/repos/0xShug0/audio.cpp/commits/main",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("resolves ComfyUI main and honors its offline override", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ sha: SHA })));
    await expect(resolveComfyUiRevision(fetcher)).resolves.toBe(SHA);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("comfyanonymous/ComfyUI/commits/main"),
      expect.anything(),
    );
    vi.stubEnv("IRIS_COMFYUI_REVISION", SHA.toUpperCase());
    fetcher.mockClear();
    await expect(resolveComfyUiRevision(fetcher)).resolves.toBe(SHA);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["non-2xx", new Response("no", { status: 503 })],
    ["malformed", new Response(JSON.stringify({ sha: "branch" }), { status: 200 })],
    ["oversize", new Response("x".repeat(64 * 1024 + 1), { status: 200 })],
  ])("rejects %s responses", async (_name, response) => {
    await expect(resolveAudioRevision(vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toThrow();
  });

  it("only accepts immutable full SHAs", () => {
    expect(validateImmutableRevision(SHA, "audio")).toBe(SHA);
    expect(() => validateImmutableRevision("main", "audio")).toThrow(/40-character/);
  });
});
