import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-admin-models-"));
  vi.resetModules();
});

describe("admin model database boundary", () => {
  it("preserves valid registration and managed removal behavior", async () => {
    const models = await import("../src/admin/models.js");
    const registered = models.registerModel({ name: "test model", path: "/tmp/test-model.gguf", ownership: "managed" });

    expect(models.listModels()).toEqual([registered]);
    expect(models.removeModel(registered.id)).toBe(true);
    expect(models.listModels()).toEqual([]);
  });

  it("fails closed for malformed rows", async () => {
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const sqlite = openDb(dataFile("admin.db")).sqlite;
    sqlite.exec(
      "CREATE TABLE admin_models (id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT NOT NULL,ownership TEXT NOT NULL,size_bytes INTEGER,format TEXT,created_at TEXT NOT NULL)",
    );
    sqlite
      .prepare("INSERT INTO admin_models VALUES (?,?,?,?,?,?,?)")
      .run("bad", "name", "/tmp/model.gguf", "unexpected", null, "gguf", "now");

    const models = await import("../src/admin/models.js");
    expect(() => models.listModels()).toThrow();
    expect(models.removeModel("bad")).toBe(false);
  });
});
