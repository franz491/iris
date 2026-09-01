/** Coordinated offline API-key master-key rotation (IRIS-062). */
import path from "node:path";
import { DATA_DIR } from "./sqlite.js";
import { createSqliteBackup, type BackupManifest } from "./recovery.js";
import { rotateApiKeys } from "../model-router/keys.js";
import { acquireMaintenanceLock } from "../runtime/maintenance-lock.js";
import { randomUUID } from "node:crypto";

export type RotationFault = "backup" | "reencrypt" | "commit" | "reload";
export interface KeyRotationOptions {
  currentKey: Buffer;
  newKey: Buffer;
  dataRoot?: string;
  tempRoot?: string;
  backupPath?: string;
  faultAt?: (point: RotationFault) => void | Promise<void>;
  backup?: () => Promise<BackupManifest>;
  rotate?: (current: Buffer, replacement: Buffer) => void;
  reload?: () => void | Promise<void>;
  audit?: (status: "started" | "completed" | "failed", operationId: string) => void | Promise<void>;
  /** Durable caller-owned journal sink; receives status only, never key material. */
  journal?: (status: "started" | "completed" | "failed", operationId: string) => void | Promise<void>;
}
export interface KeyRotationResult {
  backupPath: string;
  backup: BackupManifest;
}

/** Acquire a cross-process maintenance lock, back up keys.db, rotate atomically,
 * and reload only after successful commit. Reload failure is rolled back. */
export async function rotateApiKeysOperational(options: KeyRotationOptions): Promise<KeyRotationResult> {
  if (!Buffer.isBuffer(options.currentKey) || !Buffer.isBuffer(options.newKey))
    throw new Error("master keys are required");
  if (options.currentKey.equals(options.newKey)) throw new Error("current and new master keys must differ");
  const root = path.resolve(options.dataRoot ?? DATA_DIR);
  const lock = acquireMaintenanceLock(root, "key-rotation");
  const backupPath = options.backupPath ?? path.join(root, `recovery-key-rotation-${Date.now()}.db`);
  const backup =
    options.backup ??
    (() =>
      createSqliteBackup(path.join(root, "keys.db"), backupPath, {
        dataRoot: root,
        tempRoot: path.resolve(options.tempRoot ?? path.join(root, "recovery-tmp")),
      }));
  const rotate = options.rotate ?? rotateApiKeys;
  let committed = false;
  const operationId = randomUUID();
  const record = async (status: "started" | "completed" | "failed") => {
    await options.journal?.(status, operationId);
    await options.audit?.(status, operationId);
  };
  try {
    await record("started");
    await options.faultAt?.("backup");
    const manifest = await backup();
    await options.faultAt?.("reencrypt");
    await options.faultAt?.("commit");
    rotate(options.currentKey, options.newKey);
    committed = true;
    try {
      await options.reload?.();
      await options.faultAt?.("reload");
    } catch (error) {
      // Keep the old key usable if the runtime cannot reload the replacement.
      rotate(options.newKey, options.currentKey);
      committed = false;
      throw error;
    }
    await record("completed");
    return { backupPath, backup: manifest };
  } catch (error) {
    try {
      await record("failed");
    } catch {
      // Audit failure must not prevent lock release or hide the rotation error.
    }
    throw error;
  } finally {
    if (!committed) {
      // The transactional rotator already preserves rows on pre-commit faults.
    }
    lock.release();
  }
}
