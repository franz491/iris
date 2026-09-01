import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, utimesSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireMaintenanceLock } from "../src/runtime/maintenance-lock.js";

function root() {
  return mkdtempSync(path.join(tmpdir(), "iris-lock-"));
}
function lockPath(r: string) {
  return path.join(r, "locks", "iris-maintenance.lock");
}

describe("maintenance data-root lock", () => {
  it("rejects a live owner and permits only one contender", () => {
    const r = root();
    const first = acquireMaintenanceLock(r, "test");
    expect(() => acquireMaintenanceLock(r, "test")).toThrow("already owned");
    first.release();
    const second = acquireMaintenanceLock(r, "test");
    second.release();
  });

  it("reclaims a definitely dead PID", () => {
    const r = root();
    mkdirSync(path.join(r, "locks"), { recursive: true });
    writeFileSync(lockPath(r), JSON.stringify({ pid: 2147483647, processStartIdentity: "x" }));
    const lease = acquireMaintenanceLock(r, "recovery");
    expect(existsSync(lockPath(r))).toBe(true);
    lease.release();
  });

  it("detects PID reuse through injected identity", () => {
    const r = root();
    mkdirSync(path.join(r, "locks"), { recursive: true });
    writeFileSync(lockPath(r), JSON.stringify({ pid: 42, processStartIdentity: "old" }));
    const lease = acquireMaintenanceLock(r, "recovery", { processAlive: () => true, processIdentity: () => "new" });
    lease.release();
  });

  it("rejects fresh malformed locks but reclaims aged malformed locks", () => {
    const r = root();
    mkdirSync(path.join(r, "locks"), { recursive: true });
    writeFileSync(lockPath(r), "not-json");
    expect(() => acquireMaintenanceLock(r)).toThrow("already owned");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(r), old, old);
    const lease = acquireMaintenanceLock(r);
    lease.release();
  });

  it("does not let a released lease remove a replacement lock", () => {
    const r = root();
    const lease = acquireMaintenanceLock(r);
    const replacement = JSON.stringify({ token: "replacement", pid: 42, processStartIdentity: "old" });
    writeFileSync(lockPath(r), replacement);
    lease.release();
    expect(readFileSync(lockPath(r), "utf8")).toBe(replacement);
    // clean up through the actual owner path in a fresh lock
    const next = acquireMaintenanceLock(r, "next", { processAlive: () => false });
    next.release();
  });

  it("does not follow a symlink lock", () => {
    const r = root();
    mkdirSync(path.join(r, "locks"), { recursive: true });
    const target = path.join(r, "target");
    writeFileSync(target, "safe");
    symlinkSync(target, lockPath(r));
    expect(() => acquireMaintenanceLock(r)).toThrow("already owned");
    expect(readFileSync(target, "utf8")).toBe("safe");
  });
});
