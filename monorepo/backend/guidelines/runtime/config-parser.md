config-parser.ts - Reads the config for relevant info and gives it to the kernel.

EXPORTS

getConfig(path?: string, providerName?: string, overrideDb = false): Promise<{[providerName: string]: ProviderConfig}>
setConfig(providerName: string, config: ProviderConfig): Promise<void>
exportConfig(path?: string): Promise<void>

IMPORTS

none

FUNCTIONALITY

It should check if a local SQLite db with configurations is available. If not, it should generate it from the ../config.yaml (if path is given, use that path. if override is true, delete the DB and start fresh from the yaml). Then it retrieves the configs from the DB. Every provider uses its id (ProviderName) property for the DB entry, which is a kinda-readable name (e.g. "files" or "home-assistant").
setConfig should update the provider config in SQLite, but not in yml.
exportConfig should create a formatted yaml file (at the path specified, or ../<timestamp>.yaml if undefined) for the whole current setup of the DB.

## ASSUMPTIONS
- Config DB and default YAML live beneath `IRIS_DATA_DIR`. When it is unset,
  Iris uses the OS application-data directory rather than a source-tree path.
- overrideDb=true clears the DB so the next getConfig bootstraps again from yaml.
- No drizzle migrations infra; table created by raw SQL on first access.
- getConfig(path) uses `path` both for bootstrap reading AND as the yaml location check; after bootstrap, DB is the source of truth.
