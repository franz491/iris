import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrateTtsPlaybackDb } from "../src/admin/audio-cache.js";
describe("tts playback migration", () => {
  it("is idempotent, preserves rows, and rolls back fresh failure", () => {
    const db = new Database(":memory:");
    migrateTtsPlaybackDb(false, db);
    db.prepare("insert into admin_tts_playback values(?,?,?,?,?,?,?)").run("1", "{}", null, "audio/wav", 1, 1, 0);
    migrateTtsPlaybackDb(false, db);
    expect(db.prepare("select count(*) n from admin_tts_playback_schema_migrations").get()).toEqual({ n: 1 });
    expect(db.prepare("select id from admin_tts_playback").get()).toEqual({ id: "1" });
    const fresh = new Database(":memory:");
    expect(() => migrateTtsPlaybackDb(true, fresh)).toThrow();
    expect(fresh.prepare("select name from sqlite_master where name like 'admin_tts_playback%'").all()).toEqual([]);
  });
});
