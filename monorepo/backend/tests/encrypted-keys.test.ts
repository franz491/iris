import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const key = Buffer.alloc(32, 41).toString("base64");
beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-keys-"));
  process.env.IRIS_API_KEYS_MASTER_KEY = key;
  delete process.env.IRIS_API_KEYS_MASTER_KEY_FILE;
  vi.resetModules();
});

describe("encrypted named API keys", () => {
  it("round trips, uses distinct nonces, lists without plaintext, deletes, and bounds inputs", async () => {
    const keys = await import("../src/model-router/keys.js");
    keys.setApiKey("one", "secret-one");
    keys.setApiKey("two", "secret-two");
    expect(keys.getApiKey("one")).toBe("secret-one");
    expect(keys.listApiKeyNames()).toEqual(["one", "two"]);
    const db = new Database(path.join(process.env.IRIS_DATA_DIR!, "keys.db"));
    const rows = db.prepare("SELECT * FROM api_keys").all() as Array<Record<string, string>>;
    expect(rows[0].nonce).not.toBe(rows[1].nonce);
    expect(JSON.stringify(rows)).not.toContain("secret-one");
    expect(readFileSync(path.join(process.env.IRIS_DATA_DIR!, "keys.db")).toString()).not.toContain("secret-one");
    expect(keys.deleteApiKey("one")).toBe(true);
    expect(keys.getApiKey("one")).toBeNull();
    expect(() => keys.setApiKey("", "x")).toThrow();
    expect(() => keys.setApiKey("x", "x".repeat(4097))).toThrow();
    db.close();
  });
  it("fails closed on tampering, wrong key, and missing key", async () => {
    const keys = await import("../src/model-router/keys.js");
    keys.setApiKey("x", "secret");
    const db = new Database(path.join(process.env.IRIS_DATA_DIR!, "keys.db"));
    db.prepare("UPDATE api_keys SET tag = ?").run("AAAA");
    db.close();
    expect(() => keys.getApiKey("x")).toThrow(/Unable to decrypt/);
    vi.resetModules();
    process.env.IRIS_API_KEYS_MASTER_KEY = Buffer.alloc(32, 42).toString("base64");
    const wrong = await import("../src/model-router/keys.js");
    expect(() => wrong.getApiKey("x")).toThrow(/Unable to decrypt/);
    delete process.env.IRIS_API_KEYS_MASTER_KEY;
    vi.resetModules();
    const missing = await import("../src/model-router/keys.js");
    expect(() => missing.getApiKey("x")).toThrow(/unavailable/);
  });
  it("migrates legacy plaintext transactionally and removes the old table", async () => {
    const dir = process.env.IRIS_DATA_DIR!;
    const db = new Database(path.join(dir, "keys.db"));
    db.exec(readFileSync(path.join(process.cwd(), "tests/fixtures/api-keys-legacy-v0.sql"), "utf8"));
    db.close();
    const keys = await import("../src/model-router/keys.js");
    expect(keys.getApiKey("legacy-fixture")).toBe("legacy-secret");
    const check = new Database(path.join(dir, "keys.db"));
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'api_keys_legacy'").get()).toBeUndefined();
    expect(JSON.stringify(check.prepare("SELECT * FROM api_keys").all())).not.toContain("legacy-secret");
    check.close();
  });
  it("rolls back malformed legacy fixture and preserves both rows", async () => {
    const dir = process.env.IRIS_DATA_DIR!;
    const file = path.join(dir, "keys.db");
    const db = new Database(file);
    db.exec(readFileSync(path.join(process.cwd(), "tests/fixtures/api-keys-legacy-v0-malformed.sql"), "utf8"));
    const before = db.prepare("SELECT name,key,created_at FROM api_keys ORDER BY name").all();
    db.close();
    await expect(import("../src/model-router/keys.js")).rejects.toThrow();
    const check = new Database(file);
    expect(check.prepare("SELECT name,key,created_at FROM api_keys ORDER BY name").all()).toEqual(before);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name='api_keys_legacy'").get()).toBeUndefined();
    check.close();
  });
  it("accepts a key file only when it is exact base64 32 bytes", async () => {
    const file = path.join(process.env.IRIS_DATA_DIR!, "master.key");
    writeFileSync(file, key, { mode: 0o600 });
    chmodSync(file, 0o600);
    delete process.env.IRIS_API_KEYS_MASTER_KEY;
    process.env.IRIS_API_KEYS_MASTER_KEY_FILE = file;
    vi.resetModules();
    const keys = await import("../src/model-router/keys.js");
    keys.setApiKey("file", "value");
    expect(keys.getApiKey("file")).toBe("value");
    expect(readFileSync(file, "utf8")).toBe(key);
    expect(keys.readApiKeyMasterKeyFile(file)).toEqual(Buffer.alloc(32, 41));
  });
  it("rejects insecure or symlinked key files and multibyte byte overflow", async () => {
    const keys = await import("../src/model-router/keys.js");
    expect(keys.isPrivateMasterKeyFile(0o644, process.getuid?.(), process.getuid?.(), true)).toBe(false);
    expect(keys.isPrivateMasterKeyFile(0o600, 123, 456, true)).toBe(false);
    expect(keys.isPrivateMasterKeyFile(0o600, process.getuid?.(), process.getuid?.(), false)).toBe(false);
    expect(() => keys.setApiKey("utf8", "😀".repeat(1025))).toThrow();
    const real = path.join(process.env.IRIS_DATA_DIR!, "real.key");
    const link = path.join(process.env.IRIS_DATA_DIR!, "link.key");
    writeFileSync(real, key, { mode: 0o600 });
    symlinkSync(real, link);
    delete process.env.IRIS_API_KEYS_MASTER_KEY;
    process.env.IRIS_API_KEYS_MASTER_KEY_FILE = link;
    vi.resetModules();
    const linked = await import("../src/model-router/keys.js");
    expect(() => linked.setApiKey("link", "value")).toThrow(/private regular file/);
    expect(() => linked.readApiKeyMasterKeyFile(link)).toThrow(/private regular file/);
  });
  it("rejects an oversized configured master-key file", async () => {
    const file = path.join(process.env.IRIS_DATA_DIR!, "oversized.key");
    writeFileSync(file, `${key}${"x".repeat(257)}`, { mode: 0o600 });
    delete process.env.IRIS_API_KEYS_MASTER_KEY;
    process.env.IRIS_API_KEYS_MASTER_KEY_FILE = file;
    vi.resetModules();
    const configured = await import("../src/model-router/keys.js");
    expect(() => configured.setApiKey("oversized", "value")).toThrow(/private regular file/);
  });
  it("rotates every row with fresh nonces and rejects the old key", async () => {
    const keys = await import("../src/model-router/keys.js");
    const oldKey = Buffer.alloc(32, 41);
    const newKey = Buffer.alloc(32, 42);
    keys.setApiKey("one", "secret-one");
    keys.setApiKey("two", "secret-two");
    const db = new Database(path.join(process.env.IRIS_DATA_DIR!, "keys.db"));
    const before = db.prepare("SELECT name,nonce FROM api_keys ORDER BY name").all() as Array<{
      name: string;
      nonce: string;
    }>;
    keys.rotateApiKeys(oldKey, newKey);
    const after = db.prepare("SELECT name,nonce FROM api_keys ORDER BY name").all() as Array<{
      name: string;
      nonce: string;
    }>;
    expect(after.map((r) => r.nonce)).not.toEqual(before.map((r) => r.nonce));
    delete process.env.IRIS_API_KEYS_MASTER_KEY;
    process.env.IRIS_API_KEYS_MASTER_KEY = newKey.toString("base64");
    vi.resetModules();
    const rotated = await import("../src/model-router/keys.js");
    expect(rotated.getApiKey("two")).toBe("secret-two");
    process.env.IRIS_API_KEYS_MASTER_KEY = oldKey.toString("base64");
    vi.resetModules();
    const old = await import("../src/model-router/keys.js");
    expect(() => old.getApiKey("one")).toThrow(/Unable to decrypt/);
    db.close();
  });
  it("preflights tampered rows and leaves all rows unchanged", async () => {
    const keys = await import("../src/model-router/keys.js");
    const oldKey = Buffer.alloc(32, 41);
    const newKey = Buffer.alloc(32, 43);
    keys.setApiKey("one", "secret-one");
    keys.setApiKey("two", "secret-two");
    const db = new Database(path.join(process.env.IRIS_DATA_DIR!, "keys.db"));
    db.prepare("UPDATE api_keys SET tag='AAAA' WHERE name='two'").run();
    const before = db.prepare("SELECT name,ciphertext,nonce,tag FROM api_keys ORDER BY name").all();
    expect(() => keys.rotateApiKeys(oldKey, newKey)).toThrow();
    const after = db.prepare("SELECT name,ciphertext,nonce,tag FROM api_keys ORDER BY name").all();
    expect(after).toEqual(before);
    db.close();
  });
  it("rolls back when a database trigger fails mid-rotation", async () => {
    const keys = await import("../src/model-router/keys.js");
    const db = new Database(path.join(process.env.IRIS_DATA_DIR!, "keys.db"));
    keys.setApiKey("one", "secret");
    const before = db.prepare("SELECT ciphertext,nonce,tag FROM api_keys").get();
    db.exec(
      "CREATE TRIGGER fail_rotation BEFORE UPDATE ON api_keys BEGIN SELECT RAISE(ABORT, 'simulated failure'); END",
    );
    expect(() => keys.rotateApiKeys(Buffer.alloc(32, 41), Buffer.alloc(32, 44))).toThrow(/simulated failure/);
    expect(db.prepare("SELECT ciphertext,nonce,tag FROM api_keys").get()).toEqual(before);
    db.close();
  });
  it("rejects invalid master keys before touching the database", async () => {
    const keys = await import("../src/model-router/keys.js");
    keys.setApiKey("one", "secret");
    expect(() => keys.rotateApiKeys(Buffer.alloc(31), Buffer.alloc(32, 42))).toThrow(/exactly 32/);
    expect(() => keys.parseApiKeyMasterKey("")).toThrow();
    expect(() => keys.parseApiKeyMasterKey("not-base64")).toThrow();
  });
});
