import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-audio-"));
  vi.resetModules();
});
describe("bounded TTS cache", () => {
  it("replays cached metadata and evicts by byte limit", async () => {
    const c = await import("../src/admin/audio-cache.js");
    const limits = { maxAgeSeconds: 0, maxBytes: 3 };
    const a = c.cacheAudio(new Uint8Array([1, 2]), { text: "a" }, limits);
    const b = c.cacheAudio(new Uint8Array([3, 4]), { text: "b" }, limits);
    expect(c.readCachedAudio(a, limits)).toBeNull();
    expect(c.readCachedAudio(b, limits)?.metadata.text).toBe("b");
  });
  it("fails closed for malformed SQLite rows and metadata", async () => {
    const c = await import("../src/admin/audio-cache.js");
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const db = openDb(dataFile("admin.db")).sqlite;
    db.prepare("INSERT INTO admin_tts_playback VALUES (?,?,?,?,?,?,?)").run(
      "bad-metadata",
      JSON.stringify({ text: 42 }),
      null,
      "audio/wav",
      Date.now(),
      Date.now(),
      0,
    );
    db.prepare("INSERT INTO admin_tts_playback VALUES (?,?,?,?,?,?,?)").run(
      "bad-file",
      JSON.stringify({ text: "ok" }),
      "/tmp/outside-cache.wav",
      "audio/wav",
      Date.now(),
      Date.now(),
      1,
    );
    db.prepare("INSERT INTO admin_tts_playback VALUES (?,?,?,?,?,?,?)").run(
      "bad-mime",
      JSON.stringify({ text: "ok" }),
      null,
      "audio/wav\r\nX-Leak: yes",
      Date.now(),
      Date.now(),
      0,
    );
    expect(c.getPlaybackMetadata("bad-metadata")).toBeNull();
    expect(c.readCachedAudio("bad-file", { maxAgeSeconds: 0, maxBytes: 10 })).toBeNull();
    expect(c.getPlaybackMetadata("bad-mime")).toBeNull();
  });
  it("fails closed when a cached file is tampered or exceeds its recorded size", async () => {
    const c = await import("../src/admin/audio-cache.js");
    const id = c.cacheAudio(Buffer.from([1, 2]), { text: "tamper" }, { maxAgeSeconds: 0, maxBytes: 10 });
    const row = c.db.prepare("SELECT file FROM admin_tts_playback WHERE id=?").get(id) as { file: string };
    writeFileSync(row.file, Buffer.from([1, 2, 3]));
    expect(c.readCachedAudio(id, { maxAgeSeconds: 0, maxBytes: 10 })).toBeNull();
  });
});
