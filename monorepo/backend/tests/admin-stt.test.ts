import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeAudio } from "../src/admin/stt.js";
import { setPinnedRequestForTests, setPinnedResolverForTests, type Address } from "../src/net/pinned-http.js";

afterEach(() => {
  setPinnedResolverForTests();
  setPinnedRequestForTests();
});

describe("STT adapter", () => {
  it("returns transcript text without exposing audio payload", async () => {
    let request: Request | undefined;
    const result = await transcribeAudio(
      {
        baseUrl: "http://stt.local",
        fetchImpl: async (input, init) => {
          request = new Request(input, init);
          return Response.json({ text: "hello", language: "en" });
        },
      },
      new Uint8Array([1, 2]),
    );
    expect(result).toEqual({ text: "hello", language: "en" });
    expect(request?.url).toBe("http://stt.local/v1/audio/transcriptions");
  });

  it("uses pinned bounded production transport with a sanitized multipart filename", async () => {
    setPinnedResolverForTests(async () => [{ address: "203.0.113.11", family: 4 }]);
    const requestMock = vi.fn(
      async (_url: URL, _address: Address, _signal: AbortSignal, _init: RequestInit, _maxBytes: number) =>
        Response.json({ text: "safe" }),
    );
    setPinnedRequestForTests(requestMock);
    await expect(
      transcribeAudio(
        { baseUrl: "https://stt.example", bearerToken: "token" },
        new Uint8Array([1, 2]),
        "bad\r\nname.wav",
      ),
    ).resolves.toEqual({ text: "safe" });
    const [url, address, , init, maxBytes] = requestMock.mock.calls[0];
    expect(url.href).toBe("https://stt.example/v1/audio/transcriptions");
    expect(address).toEqual({ address: "203.0.113.11", family: 4 });
    expect(maxBytes).toBe(1024 * 1024);
    expect(init.headers).toEqual(expect.objectContaining({ authorization: "Bearer token" }));
    expect(Buffer.from(init.body as ArrayBuffer).toString("utf8")).not.toContain("\r\nname.wav");
  });

  it("bounds response JSON before parsing", async () => {
    await expect(
      transcribeAudio(
        {
          baseUrl: "http://stt.local",
          fetchImpl: async () => new Response(new Uint8Array(1024 * 1024 + 1)),
        },
        new Uint8Array([1]),
      ),
    ).rejects.toThrow(/response body exceeds/);
  });
});
