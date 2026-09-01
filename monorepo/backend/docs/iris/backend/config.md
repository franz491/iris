# Provider configuration (config.yaml round-trip)

Iris providers (files, shell, docs, memory, audio, search) are configured per
machine through the **config DB** (`<dataDir>/config.db`). A yaml file is used
as a **bootstrap** convenience.

## Bootstrap flow

1. On startup the kernel loads all provider rows from the config DB.
2. If the DB has **no rows** and `<dataDir>/config.yaml` exists, each top-level
   yaml key is inserted as a provider config (see
   `misc/config.example.yaml`). The yaml is then ignored — the DB is the
   source of truth.
3. If neither exists, the kernel starts with an empty config (providers are
   registered but inactive).

## Editing configuration

- **Runtime**: `kernel.setConfig([...])` / the config CLI paths write to the
  DB; changes apply without restarting (providers reload).
- **Fresh start from yaml**: delete `<dataDir>/config.db` (or pass
  `overrideDb=true`) and edit `<dataDir>/config.yaml`.

## Format

```yaml
<providerName>:
  activeFunctionalities: [ ... ]      # which functionalities are callable
  additionalSettings: { ... }         # provider-specific options
```

See `misc/config.example.yaml` for every supported provider, its
functionalities, and settings. The always-on `memory` provider is
auto-activated with sane defaults on fresh installs when no config exists.

## Where functionality names come from

Each provider declares its functionalities in code
(`src/providers/installed/*.ts`, documented alongside in
`providers/installed/*.md`). Only listed names may appear in
`activeFunctionalities`; unknown ones make calls fail with
`unknown_functionality`.
