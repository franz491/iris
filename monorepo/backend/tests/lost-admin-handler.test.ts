import { beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-lost-handler-"));
  vi.resetModules();
});

describe("lost-admin CLI handler", () => {
  it("rejects unsafe confirmation, actor, identifiers, and credential sources before reset", async () => {
    const { handleLostAdminRecovery } = await import("../src/cli/lost-admin.js");
    const reset = vi.fn(async () => 0);
    const base = {
      env: { IRIS_RECOVERY_ACTOR: "admin", IRIS_RECOVERY_CONFIRM: "NO" },
      isAdmin: () => true,
      countAdmins: () => 1,
      reset,
      findUsers: () => [{ id: "u", name: "u", email: "u@iris.local", role: "admin" }],
    };
    await expect(handleLostAdminRecovery(["u", "--stdin"], base)).rejects.toThrow(/LOST_ADMIN_RECOVERY/);
    await expect(
      handleLostAdminRecovery(["u", "--credential-file", "/nope"], {
        ...base,
        env: { ...base.env, IRIS_RECOVERY_CONFIRM: "LOST_ADMIN_RECOVERY" },
        isAdmin: () => false,
      }),
    ).rejects.toThrow(/administrator/);
    await expect(
      handleLostAdminRecovery(["u", "secret"], {
        ...base,
        env: { ...base.env, IRIS_RECOVERY_CONFIRM: "LOST_ADMIN_RECOVERY" },
      }),
    ).rejects.toThrow(/protected/);
    expect(reset).not.toHaveBeenCalled();
  });

  it("rejects 0644, symlink, directory, ambiguous, and missing targets", async () => {
    const { handleLostAdminRecovery } = await import("../src/cli/lost-admin.js");
    const root = mkdtempSync(path.join(tmpdir(), "iris-credential-"));
    const file = path.join(root, "credential");
    writeFileSync(file, "new-password-1\n");
    chmodSync(file, 0o644);
    const base = {
      env: { IRIS_RECOVERY_ACTOR: "admin", IRIS_RECOVERY_CONFIRM: "LOST_ADMIN_RECOVERY" },
      isAdmin: () => true,
      countAdmins: () => 1,
      reset: vi.fn(async () => 0),
    };
    await expect(
      handleLostAdminRecovery(["u", "--credential-file", file], {
        ...base,
        findUsers: () => [{ id: "u", name: "u", email: "u@iris.local", role: "admin" }],
      }),
    ).rejects.toThrow(/0600/);
    chmodSync(file, 0o600);
    const link = path.join(root, "link");
    symlinkSync(file, link);
    await expect(
      handleLostAdminRecovery(["u", "--credential-file", link], {
        ...base,
        findUsers: () => [{ id: "u", name: "u", email: "u@iris.local", role: "admin" }],
      }),
    ).rejects.toThrow(/0600/);
    await expect(
      handleLostAdminRecovery(["u", "--credential-file", root], {
        ...base,
        findUsers: () => [{ id: "u", name: "u", email: "u@iris.local", role: "admin" }],
      }),
    ).rejects.toThrow(/0600/);
    await expect(
      handleLostAdminRecovery(["u", "--credential-file", file], { ...base, findUsers: () => [] }),
    ).rejects.toThrow(/no such/);
    await expect(
      handleLostAdminRecovery(["u", "--credential-file", file], {
        ...base,
        findUsers: () => [
          { id: "1", name: "u", email: "u@iris.local", role: "user" },
          { id: "2", name: "u", email: "u2@iris.local", role: "user" },
        ],
      }),
    ).rejects.toThrow(/ambiguous/);
  });
});
