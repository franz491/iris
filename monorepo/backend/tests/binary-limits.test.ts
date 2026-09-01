import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  declaredBodyExceedsLimit,
  decodeBoundedBase64,
  readBoundedBody,
  readBoundedResponse,
  streamToPrivateTemp,
  validateWavUpload,
} from "../src/api/binary-limits.js";
describe("binary limits", () => {
  it("checks declared lengths and base64 boundaries", () => {
    expect(declaredBodyExceedsLimit("11", 10)).toBe(true);
    expect(declaredBodyExceedsLimit("x", 10)).toBe(false);
    expect(decodeBoundedBase64(Buffer.from("abc").toString("base64"), 3)).toEqual(Buffer.from("abc"));
    expect(() => decodeBoundedBase64("x".repeat(20), 3)).toThrow();
  });
  it("bounds streamed request and response bodies", async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2]));
        c.enqueue(new Uint8Array([3]));
        c.close();
      },
    });
    expect(
      await readBoundedBody(new Request("http://x", { method: "POST", body, duplex: "half" } as RequestInit), 3),
    ).toEqual(Buffer.from([1, 2, 3]));
    const response = new Response(new Uint8Array([1, 2]));
    expect(await readBoundedResponse(response, 2)).toEqual(Buffer.from([1, 2]));
    await expect(
      readBoundedBody(new Request("http://x", { method: "POST", headers: { "content-length": "4" }, body: "1234" }), 3),
    ).rejects.toThrow();
  });

  it("rejects declared request and response length mismatches", async () => {
    const request = new Request("http://x", {
      method: "POST",
      headers: { "content-length": "4" },
      body: "123",
    });
    await expect(readBoundedBody(request, 10)).rejects.toThrow(/length/);
    const response = new Response("123", { headers: { "content-length": "4" } });
    await expect(readBoundedResponse(response, 10)).rejects.toThrow(/length/);
  });
  it("rejects non-WAV uploads", () => {
    const wav = Buffer.alloc(44);
    wav.write("RIFF");
    wav.write("WAVE", 8, "ascii");
    expect(validateWavUpload(wav, "audio/wav; charset=binary")).toBe("audio/wav");
    expect(() => validateWavUpload(Buffer.alloc(44), "audio/wav")).toThrow();
    expect(() => validateWavUpload(wav, "audio/mp3")).toThrow();
  });

  it("streams to a private temp file with a bounded prefix and idempotent cleanup", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "iris-upload-temp-"));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    const upload = await streamToPrivateTemp(
      new Request("http://x", { method: "PUT", body, duplex: "half" } as RequestInit),
      { tempRoot, limit: 4 },
    );
    expect(upload.bytes).toBe(4);
    expect(upload.signaturePrefix).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(statSync(upload.path).mode & 0o777).toBe(0o600);
    await upload.cleanup();
    await upload.cleanup();
    expect(existsSync(upload.path)).toBe(false);
  });

  it("removes the private temp file on overflow and source failure", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "iris-upload-temp-"));
    const overflowing = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4]));
        controller.close();
      },
    });
    await expect(
      streamToPrivateTemp(
        new Request("http://x", { method: "PUT", body: overflowing, duplex: "half" } as RequestInit),
        {
          tempRoot,
          limit: 3,
        },
      ),
    ).rejects.toThrow(/exceeds/);
    await expect((await import("node:fs/promises")).readdir(tempRoot)).resolves.toEqual([]);

    const failedBody = new ReadableStream({
      start(controller) {
        controller.error(new Error("stream failed"));
      },
    });
    await expect(
      streamToPrivateTemp(new Request("http://x", { method: "PUT", body: failedBody, duplex: "half" } as RequestInit), {
        tempRoot,
        limit: 3,
      }),
    ).rejects.toThrow("stream failed");
    await expect((await import("node:fs/promises")).readdir(tempRoot)).resolves.toEqual([]);
  });

  it("cancels an in-flight request and removes its private temp file", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "iris-upload-temp-"));
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream({
      start(streamController) {
        streamController.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = streamToPrivateTemp(
      new Request("http://x", { method: "PUT", body, duplex: "half", signal: controller.signal } as RequestInit),
      { tempRoot, limit: 3, signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toThrow("upload aborted");
    expect(cancelled).toBe(true);
    await expect((await import("node:fs/promises")).readdir(tempRoot)).resolves.toEqual([]);
  });
});
