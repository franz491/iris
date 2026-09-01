import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteBackup, makeRecoveryPairManifest, restoreSqliteBackup } from "../src/db/recovery.js";
import { migrateChatDb } from "../src/chat/migrations.js";
import { describe, expect, it } from "vitest";

describe("chat migration offline rollback drill", () => {
  it("leaves legacy source unchanged after injected failure and restores cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "iris-chat-drill-"));
    const source = join(root, "legacy.db");
    const backup = join(root, "backup.db");
    const restored = join(root, "restored.db");
    try {
      const db = new Database(source);
      db.exec(
        "CREATE TABLE chats (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL); INSERT INTO chats VALUES ('legacy-chat', 42);",
      );
      const before = createHash("sha256").update(readFileSync(source)).digest("hex");
      db.close();
      const roots = { dataRoot: root, tempRoot: join(root, "tmp") };
      const raw = await createSqliteBackup(source, backup, roots);
      const manifest = makeRecoveryPairManifest(backup, roots, raw);
      const failed = new Database(source);
      expect(() =>
        migrateChatDb(failed, {
          clock: () => 1,
          authDbPath: join(root, "missing-auth.db"),
          onBeforeMigration: () => {
            throw new Error("drill");
          },
        }),
      ).toThrow("drill");
      failed.close();
      expect(createHash("sha256").update(readFileSync(source)).digest("hex")).toBe(before);
      restoreSqliteBackup(backup, restored, manifest, roots, true);
      const recovered = new Database(restored);
      migrateChatDb(recovered, { clock: () => 2, authDbPath: join(root, "missing-auth.db") });
      expect(recovered.prepare("SELECT created_at FROM chats WHERE id='legacy-chat'").get()).toEqual({
        created_at: 42,
      });
      expect(recovered.prepare("SELECT version FROM chat_schema_migrations").get()).toEqual({ version: 1 });
      recovered.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
