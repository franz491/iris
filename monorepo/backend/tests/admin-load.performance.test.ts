import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-admin-performance-"));
});

describe("admin load performance contract", () => {
  it("returns a deterministic bounded audit page from a large history", async () => {
    const store = await import("../src/admin/store.js");
    const total = 1_200;
    store.sqlite.transaction(() => {
      const insert = store.sqlite.prepare("INSERT INTO admin_audit VALUES (?,?,?,?,?,?)");
      for (let i = 1; i <= total; i++) {
        insert.run(
          `audit-${i}`,
          "actor",
          "fixture.action",
          null,
          "{}",
          new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        );
      }
    })();

    const entries = store.listAudit();
    expect(entries).toHaveLength(store.MAX_AUDIT_ENTRIES);
    expect(entries[0]?.id).toBe("audit-1200");
    expect(entries.at(-1)?.id).toBe("audit-201");
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(store.MAX_AUDIT_ENTRIES);
    expect({ total, returned: entries.length, operations: 1 }).toEqual({
      total: 1_200,
      returned: 1_000,
      operations: 1,
    });
  });
});
