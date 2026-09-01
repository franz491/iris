import Database from "better-sqlite3";
export interface ChatMigrationDependencies {
  clock: () => number;
  authDbPath: string;
  onAuthNameRepairError?: (message: string) => void;
  /** Test-only fault injection immediately before the migration ledger commit. */
  onBeforeRecord?: (version: number) => void;
  onBeforeMigration?: () => void;
}

const CHAT_MIGRATION_TABLE = "chat_schema_migrations";

function hasChatMigration(connection: Database.Database, version: number): boolean {
  return (
    connection.prepare(`SELECT 1 FROM ${CHAT_MIGRATION_TABLE} WHERE version = ? LIMIT 1`).get(version) !== undefined
  );
}

function recordChatMigration(connection: Database.Database, version: number, deps: ChatMigrationDependencies): void {
  connection
    .prepare(`INSERT INTO ${CHAT_MIGRATION_TABLE} (version, applied_at) VALUES (?, ?)`)
    .run(version, deps.clock());
}

/** Create all tables if they don't exist. */
export function migrateChatDb(connection: Database.Database, deps: ChatMigrationDependencies): void {
  deps.onBeforeMigration?.();
  connection.exec(`
    CREATE TABLE IF NOT EXISTS chat_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('user','ai')),
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS participants_chat_idx ON participants(chat_id);
    CREATE TABLE IF NOT EXISTS user_participants (
      participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
      user_id TEXT,
      avatar TEXT
    );
    CREATE INDEX IF NOT EXISTS user_participants_user_idx ON user_participants(user_id);
    CREATE TABLE IF NOT EXISTS ai_participants (
      participant_id TEXT PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      api_router TEXT NOT NULL DEFAULT 'openai-compat',
      api_additional_fields TEXT NOT NULL DEFAULT '{}',
      reads_others_thoughts INTEGER NOT NULL DEFAULT 0,
      prompt TEXT NOT NULL DEFAULT '',
      will_reply_prompt TEXT NOT NULL DEFAULT '',
      last_compacted_message_id TEXT,
      compacted_context TEXT,
      max_context INTEGER NOT NULL DEFAULT 8192,
      CHECK (max_context > 0)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES participants(id),
      type TEXT NOT NULL,
      thought TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_chat_created_idx ON messages(chat_id, created_at, id);
    CREATE INDEX IF NOT EXISTS messages_author_created_idx ON messages(author_id, created_at, id);
    CREATE INDEX IF NOT EXISTS messages_superseded_by_idx ON messages(superseded_by);
    CREATE TABLE IF NOT EXISTS message_recipients (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, participant_id)
    );
    CREATE INDEX IF NOT EXISTS message_recipients_participant_idx ON message_recipients(participant_id, message_id);
    CREATE TABLE IF NOT EXISTS ai_cards (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT 'default',
      api_router TEXT NOT NULL DEFAULT 'llamacpp',
      max_context INTEGER NOT NULL DEFAULT 8192,
      prompt TEXT NOT NULL DEFAULT '',
      avatar_seed TEXT,
      avatar TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_cards_owner_idx ON ai_cards(owner_user_id);
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_settings (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      user_interruptions INTEGER NOT NULL DEFAULT 1,
      ai_interruptions INTEGER NOT NULL DEFAULT 0,
      loaded_tools TEXT,
      force_ai_reply INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS attachment_staging (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attachment_staging_created_idx ON attachment_staging(created_at);
  `);

  // Version 1 records the pre-existing column/data migrations as one atomic
  // compatibility step. A partially completed step is rolled back and will
  // be retried on the next startup; completed databases do no work here.
  if (hasChatMigration(connection, 1)) return;
  connection.transaction(() => {
    // lightweight column migrations for pre-existing DBs
    const cols = (table: string) =>
      (connection.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols("participants").includes("added_at")) {
      connection.exec("ALTER TABLE participants ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0");
      connection.exec("UPDATE participants SET added_at = created_at WHERE added_at = 0");
    }
    if (!cols("ai_participants").includes("compaction_threshold")) {
      connection.exec("ALTER TABLE ai_participants ADD COLUMN compaction_threshold INTEGER NOT NULL DEFAULT 80");
    }
    if (!cols("ai_participants").includes("api_key_name")) {
      connection.exec("ALTER TABLE ai_participants ADD COLUMN api_key_name TEXT");
    }
    if (!cols("chats").includes("name")) {
      connection.exec("ALTER TABLE chats ADD COLUMN name TEXT");
    }
    if (!cols("ai_participants").includes("card_id")) {
      connection.exec("ALTER TABLE ai_participants ADD COLUMN card_id TEXT");
    }
    if (!cols("user_participants").includes("avatar")) {
      connection.exec("ALTER TABLE user_participants ADD COLUMN avatar TEXT");
    }
    // pre-existing ai_cards tables may lack the newer avatar columns
    if (cols("ai_cards").length > 0) {
      if (!cols("ai_cards").includes("avatar_seed")) {
        connection.exec("ALTER TABLE ai_cards ADD COLUMN avatar_seed TEXT");
      }
      if (!cols("ai_cards").includes("avatar")) {
        connection.exec("ALTER TABLE ai_cards ADD COLUMN avatar TEXT");
      }
      if (!cols("ai_cards").includes("api_router")) {
        connection.exec("ALTER TABLE ai_cards ADD COLUMN api_router TEXT NOT NULL DEFAULT 'llamacpp'");
      }
      if (!cols("ai_cards").includes("max_context")) {
        connection.exec("ALTER TABLE ai_cards ADD COLUMN max_context INTEGER NOT NULL DEFAULT 8192");
      }
    }
    if (!cols("chat_settings").includes("loaded_tools")) {
      connection.exec("ALTER TABLE chat_settings ADD COLUMN loaded_tools TEXT");
    }
    if (!cols("chat_settings").includes("force_ai_reply")) {
      connection.exec("ALTER TABLE chat_settings ADD COLUMN force_ai_reply INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols("messages").includes("seq")) {
      connection.exec("ALTER TABLE messages ADD COLUMN seq INTEGER");
      // repair chats created before the creator's participant used their real
      // name (it was hardcoded to "you"). Names come from the SEPARATE auth.db.
      try {
        let authDb: InstanceType<typeof Database> | null = null;
        try {
          authDb = new Database(deps.authDbPath, { readonly: true });
        } catch {
          authDb = null; // no auth db yet (fresh installs)
        }
        if (authDb) {
          const names = new Map<string, string>();
          for (const r of authDb.prepare('SELECT id, name, email FROM "user"').all() as {
            id: string;
            name: string;
            email: string;
          }[]) {
            names.set(r.id, r.name || r.email.split("@")[0]);
          }
          const ups = connection.prepare("SELECT participant_id, user_id FROM user_participants").all() as {
            participant_id: string;
            user_id: string;
          }[];
          const fix = connection.prepare(
            "UPDATE participants SET name = ? WHERE id = ? AND type = 'user' AND name = 'you'",
          );
          for (const up of ups) {
            const name = names.get(up.user_id);
            if (name) fix.run(name, up.participant_id);
          }
          authDb.close();
        }
      } catch (e) {
        deps.onAuthNameRepairError?.(`'you' name repair skipped: ${e instanceof Error ? e.message : e}`);
      }
      connection.exec(
        "UPDATE messages SET seq = (SELECT COUNT(*) FROM messages m2 WHERE m2.chat_id = messages.chat_id AND (m2.created_at < messages.created_at OR (m2.created_at = messages.created_at AND m2.id <= messages.id)))",
      );
      connection.exec("CREATE INDEX IF NOT EXISTS messages_chat_seq_idx ON messages(chat_id, seq)");
    }
    deps.onBeforeRecord?.(1);
    recordChatMigration(connection, 1, deps);
  })();
}
