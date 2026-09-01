import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { defaultDataDirectory } from "../src/db/sqlite.js";
import { chmodSync, lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";

describe("defaultDataDirectory", () => {
  it("uses OS application-data conventions without a source-tree fallback", () => {
    expect(defaultDataDirectory("linux", "/home/iris", undefined, undefined)).toBe("/home/iris/.local/share/iris");
    expect(defaultDataDirectory("linux", "/home/iris", "/var/data", undefined)).toBe("/var/data/iris");
    expect(defaultDataDirectory("darwin", "/Users/iris", undefined, undefined)).toBe(
      "/Users/iris/Library/Application Support/Iris",
    );
    expect(defaultDataDirectory("win32", "C:\\Users\\iris", undefined, "D:\\IrisData")).toBe(
      path.join("D:\\IrisData", "Iris"),
    );
  });
});

describe("data directory safety", () => {
  it("does not follow a symlinked configured data root", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const parent = mkdtempSync(join(tmpdir(), "iris-data-root-"));
    const target = join(parent, "target");
    const link = join(parent, "link");
    mkdirSync(target);
    symlinkSync(target, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const prior = process.env.IRIS_DATA_DIR;
    process.env.IRIS_DATA_DIR = link;
    try {
      vi.resetModules();
      const sqlite = await import("../src/db/sqlite.js");
      expect(() => sqlite.dataFile("settings.json")).toThrow("must not be a symbolic link");
    } finally {
      process.env.IRIS_DATA_DIR = prior;
      vi.resetModules();
    }
  });

  it("repairs permissions on the data root and database files", async () => {
    if (process.platform === "win32") return;
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-permissions-"));
    vi.resetModules();
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    chmodSync(dataFile("."), 0o755);

    const databasePath = dataFile("permissions.db");
    const initial = openDb(databasePath);
    initial.sqlite.close();
    chmodSync(databasePath, 0o644);
    const { sqlite } = openDb(databasePath);
    sqlite.close();

    expect(statSync(dataFile(".")).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it("rejects database paths outside the configured data root", async () => {
    vi.resetModules();
    const { openDb } = await import("../src/db/sqlite.js");
    expect(() => openDb("/tmp/iris-outside.db")).toThrow("must stay within IRIS_DATA_DIR");
  });

  it("rejects a symlinked nested database path", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-nested-link-"));
    vi.resetModules();
    const { dataFile, openDb } = await import("../src/db/sqlite.js");
    const target = dataFile("nested-target.db");
    const link = dataFile("nested-link.db");
    writeFileSync(target, "not a database");
    symlinkSync(target, link);
    expect(() => openDb(link)).toThrow("must not be symbolic links");
  });
});
