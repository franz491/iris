import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-key-rotation-"));
});

describe("coordinated API-key rotation", () => {
  const oldKey = Buffer.alloc(32, 1);
  const newKey = Buffer.alloc(32, 2);
  const manifest = { version: 1 as const, sha256: "a".repeat(64), bytes: 1, createdAt: "2026-01-01T00:00:00.000Z" };

  it("backs up, rotates, reloads, and returns no key material", async () => {
    const { rotateApiKeysOperational } = await import("../src/db/key-rotation.js");
    const order: string[] = [];
    const statuses: string[] = [];
    const result = await rotateApiKeysOperational({
      currentKey: oldKey,
      newKey,
      backup: async () => {
        order.push("backup");
        return manifest;
      },
      rotate: () => order.push("rotate"),
      reload: () => order.push("reload"),
      journal: (status) => statuses.push(status),
      audit: (status) => order.push(`audit:${status}`),
      backupPath: path.join(process.env.IRIS_DATA_DIR!, "verified.db"),
    });
    expect(order).toEqual(["audit:started", "backup", "rotate", "reload", "audit:completed"]);
    expect(statuses).toEqual(["started", "completed"]);
    expect(result).toEqual({ backupPath: path.join(process.env.IRIS_DATA_DIR!, "verified.db"), backup: manifest });
    expect(JSON.stringify(result)).not.toContain(oldKey.toString("base64"));
    expect(JSON.stringify(result)).not.toContain(newKey.toString("base64"));
  });

  it.each(["backup", "reencrypt", "commit"] as const)("preserves the old key on %s fault", async (fault) => {
    const { rotateApiKeysOperational } = await import("../src/db/key-rotation.js");
    let rotations = 0;
    const statuses: string[] = [];
    await expect(
      rotateApiKeysOperational({
        currentKey: oldKey,
        newKey,
        backup: async () => manifest,
        rotate: () => rotations++,
        audit: (status) => statuses.push(status),
        faultAt: (point) => {
          if (point === fault) throw new Error(`${fault} fault`);
        },
      }),
    ).rejects.toThrow(`${fault} fault`);
    expect(rotations).toBe(0);
    expect(statuses).toEqual(["started", "failed"]);
  });

  it("rolls back the committed rotation when reload fails", async () => {
    const { rotateApiKeysOperational } = await import("../src/db/key-rotation.js");
    const rotations: string[] = [];
    await expect(
      rotateApiKeysOperational({
        currentKey: oldKey,
        newKey,
        backup: async () => manifest,
        rotate: (from, to) => rotations.push(`${from[0]}-${to[0]}`),
        reload: () => {
          throw new Error("reload fault");
        },
      }),
    ).rejects.toThrow("reload fault");
    expect(rotations).toEqual(["1-2", "2-1"]);
  });

  it("rejects a concurrent maintenance operation", async () => {
    const { rotateApiKeysOperational } = await import("../src/db/key-rotation.js");
    const root = process.env.IRIS_DATA_DIR!;
    mkdirSync(path.join(root, "locks"), { recursive: true });
    writeFileSync(path.join(root, "locks", "iris-maintenance.lock"), "active", { mode: 0o600 });
    await expect(
      rotateApiKeysOperational({ currentKey: oldKey, newKey, dataRoot: root, backup: async () => manifest }),
    ).rejects.toThrow("already owned");
  });

  it("releases ownership idempotently for the next maintenance operation", async () => {
    const { acquireMaintenanceLock } = await import("../src/runtime/maintenance-lock.js");
    const root = process.env.IRIS_DATA_DIR!;
    const first = acquireMaintenanceLock(root, "runtime");
    first.release();
    first.release();
    const second = acquireMaintenanceLock(root, "key-rotation");
    expect(second.path).toContain("iris-maintenance.lock");
    second.release();
  });
});
