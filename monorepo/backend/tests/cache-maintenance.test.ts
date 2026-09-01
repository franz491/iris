import { beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

describe("offline cache maintenance", () => {
  beforeEach(() => {
    process.env.IRIS_DATA_DIR = mkdtempSync(join(tmpdir(), "iris-purge-"));
    vi.resetModules();
  });
  async function fixture(enabled = false) {
    const { dataFile } = await import("../src/db/sqlite.js");
    const db = new Database(dataFile("admin.db"));
    db.exec(
      "CREATE TABLE admin_state (id INTEGER PRIMARY KEY, config TEXT); CREATE TABLE admin_tts_playback (id TEXT PRIMARY KEY, metadata TEXT, file TEXT, mime_type TEXT, created_at INTEGER, last_access INTEGER, bytes INTEGER);",
    );
    db.prepare("INSERT INTO admin_state VALUES (1, ?)").run(JSON.stringify({ cache: { enabled } }));
    db.prepare("INSERT INTO admin_tts_playback VALUES ('x','{}',NULL,'audio/wav',1,1,0)").run();
    db.close();
    return { db: dataFile("admin.db"), cache: dataFile("tts-cache") };
  }
  it("dry-run is non-mutating and apply removes exact rows/files", async () => {
    const f = await fixture();
    mkdirSync(f.cache);
    writeFileSync(join(f.cache, "x.wav"), "x");
    writeFileSync(join(f.cache, "keep.txt"), "k");
    const { maintainOfflineCache } = await import("../src/admin/cache-maintenance.js");
    expect(maintainOfflineCache()).toMatchObject({ dryRun: true, rows: 1 });
    expect(readFileSync(join(f.cache, "x.wav"), "utf8")).toBe("x");
    expect(maintainOfflineCache({ apply: true, confirmation: "CACHE_PURGE" }).rows).toBe(1);
    const db = new Database(f.db, { readonly: true });
    expect(db.prepare("select count(*) n from admin_tts_playback").get()).toEqual({ n: 0 });
    db.close();
    expect(() => readFileSync(join(f.cache, "keep.txt"), "utf8")).toThrow();
  });
  it("rejects enabled cache and missing confirmation", async () => {
    await fixture(true);
    const { maintainOfflineCache } = await import("../src/admin/cache-maintenance.js");
    expect(() => maintainOfflineCache()).toThrow(/disabled/);
    process.env.IRIS_DATA_DIR = mkdtempSync(join(tmpdir(), "iris-purge-"));
    vi.resetModules();
    await fixture(false);
    const m = await import("../src/admin/cache-maintenance.js");
    expect(() => m.maintainOfflineCache({ apply: true })).toThrow(/CACHE_PURGE/);
  });
  it("rejects symlinked roots and cache directories", async () => {
    const f = await fixture();
    const outside = mkdtempSync(join(tmpdir(), "iris-purge-outside-"));
    const { maintainOfflineCache } = await import("../src/admin/cache-maintenance.js");
    const linkedRoot = `${f.db}-root-link`;
    symlinkSync(join(f.db, ".."), linkedRoot);
    expect(() => maintainOfflineCache({ dataRoot: linkedRoot })).toThrow(/symlink/);
    symlinkSync(outside, f.cache);
    expect(() => maintainOfflineCache()).toThrow(/cache directory symlink/);
  });
  it("fails bounded on an exclusive lock, then closes cleanly", async () => {
    const f = await fixture();
    mkdirSync(f.cache);
    writeFileSync(join(f.cache, "x.wav"), "x");
    const lock = new Database(f.db);
    lock.exec("BEGIN EXCLUSIVE");
    const { maintainOfflineCache } = await import("../src/admin/cache-maintenance.js");
    expect(() => maintainOfflineCache({ apply: true, confirmation: "CACHE_PURGE" })).toThrow();
    lock.exec("ROLLBACK");
    lock.close();
    expect(maintainOfflineCache({ apply: true, confirmation: "CACHE_PURGE" }).dryRun).toBe(false);
    const reopened = new Database(f.db);
    reopened.close();
  });
  it("rejects cache artifact swapped to symlink during revalidation", async () => {
    const f = await fixture();
    mkdirSync(f.cache);
    const target = join(f.cache, "x.wav");
    writeFileSync(target, "x");
    const outside = join(dirname(f.db), "outside");
    writeFileSync(outside, "safe");
    const { maintainOfflineCache } = await import("../src/admin/cache-maintenance.js");
    expect(() =>
      maintainOfflineCache({
        apply: true,
        confirmation: "CACHE_PURGE",
        beforeMutation: () => {
          unlinkSync(target);
          symlinkSync(outside, target);
        },
      }),
    ).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("safe");
    renameSync(f.db, `${f.db}.moved`);
    renameSync(`${f.db}.moved`, f.db);
  });
});
