// runtime/config-parser.ts
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { eq } from "drizzle-orm";
import { openDb, dataFile } from "../db/sqlite.js";
import { providerConfigs } from "./config-schema.js";
import type { ProviderConfig } from "./types.js";
import { ConfigError } from "../misc/error.js";
import { eventRecord, logger } from "../misc/logging.js";
import Database from "better-sqlite3";
import { redactSecrets } from "../admin/schema.js";

const log = logger("config-parser");

const DEFAULT_CONFIG_FILE = dataFile("config.yaml");
const CONFIG_DB_FILE = dataFile("config.db");

type ConfigDb = ReturnType<typeof openDb>["db"];

let db: ConfigDb | null = null;
export function migrateConfigDb(connection: Database.Database, injectFailure = false): void {
  connection.transaction(() => {
    connection.exec(
      "CREATE TABLE IF NOT EXISTS provider_configs (name TEXT PRIMARY KEY, active_functionalities TEXT NOT NULL, additional_settings TEXT NOT NULL)",
    );
    if (injectFailure) throw new Error("injected config migration failure");
    connection.exec(
      "CREATE TABLE IF NOT EXISTS config_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    connection.prepare("INSERT OR IGNORE INTO config_schema_migrations VALUES (1, ?)").run(Date.now());
  })();
}

function getDb(): ConfigDb {
  if (!db) {
    const opened = openDb(CONFIG_DB_FILE);
    db = opened.db;
    migrateConfigDb(opened.sqlite);
  }
  return db;
}

interface YamlProviderConfig {
  activeFunctionalities?: string[];
  additionalSettings?: Record<string, unknown>;
}
type YamlConfig = Record<string, YamlProviderConfig>;

function yamlToConfigs(yaml: YamlConfig): ProviderConfig[] {
  return Object.entries(yaml).map(([name, c]) => ({
    name,
    activeFunctionalities: c.activeFunctionalities ?? [],
    additionalSettings: c.additionalSettings ?? {},
  }));
}

/**
 * Get provider configs. If the config DB doesn't exist yet, it is bootstrapped
 * from the yaml file (default path: <dataDir>/config.yaml).
 */
export async function getConfig(
  path?: string,
  providerName?: string,
  overrideDb = false,
): Promise<Record<string, ProviderConfig>> {
  const database = getDb();
  const yamlPath = path ?? DEFAULT_CONFIG_FILE;

  if (overrideDb && existsSync(CONFIG_DB_FILE)) {
    log.info(JSON.stringify(eventRecord("config", "config.rebootstrap", { outcome: "started" })));
    database.run("DELETE FROM provider_configs");
  }

  const existing = await database.select().from(providerConfigs);
  if (existing.length === 0) {
    if (!existsSync(yamlPath)) {
      log.warn(JSON.stringify(eventRecord("config", "config.source_missing", { outcome: "empty" }, "warn")));
    } else {
      const raw = await readFile(yamlPath, "utf8");
      const parsed = parseYaml(raw) as YamlConfig;
      if (parsed && typeof parsed === "object") {
        for (const cfg of yamlToConfigs(parsed)) {
          await setConfig(cfg.name, cfg);
        }
        log.info(JSON.stringify(eventRecord("config", "config.bootstrapped")));
      }
    }
  }

  const rows = providerName
    ? await database.select().from(providerConfigs).where(eq(providerConfigs.name, providerName))
    : await database.select().from(providerConfigs);

  const out: Record<string, ProviderConfig> = {};
  for (const r of rows) {
    out[r.name] = {
      name: r.name,
      activeFunctionalities: r.activeFunctionalities,
      additionalSettings: r.additionalSettings,
    };
  }
  return out;
}

/** Update a single provider's config in the DB (not in the yaml). */
export async function setConfig(providerName: string, config: ProviderConfig): Promise<void> {
  if (config.name !== providerName) {
    throw new ConfigError("config.name must match providerName");
  }
  await getDb()
    .insert(providerConfigs)
    .values({
      name: providerName,
      activeFunctionalities: config.activeFunctionalities,
      additionalSettings: config.additionalSettings,
    })
    .onConflictDoUpdate({
      target: providerConfigs.name,
      set: {
        activeFunctionalities: config.activeFunctionalities,
        additionalSettings: config.additionalSettings,
      },
    });
}

/** Export the whole current DB setup as a formatted yaml file. */
export async function exportConfig(path?: string): Promise<string> {
  const configs = await getConfig();
  const yamlObj: YamlConfig = {};
  for (const cfg of Object.values(configs)) {
    yamlObj[cfg.name] = {
      activeFunctionalities: cfg.activeFunctionalities,
      additionalSettings: cfg.additionalSettings,
    };
  }
  const { stringify: stringifyYaml } = await import("yaml");
  const out = stringifyYaml(redactSecrets(yamlObj), { sortMapEntries: true });
  const outPath = path ?? dataFile(`${Date.now()}.yaml`);
  await writeFile(outPath, out, "utf8");
  log.info(JSON.stringify(eventRecord("config", "config.exported")));
  return outPath;
}

/** Test helper. */
export function _resetConfigDb(): void {
  db = null;
}
