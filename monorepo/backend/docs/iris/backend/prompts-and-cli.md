# Iris backend — prompts & admin CLI

## Prompt library (`src/prompts/`)

Named prompts resolve in order (first hit wins):
1. DB override — prompt_prefs table, set via CLI `prompt set <key> <file|->`
2. Machine file — `<dataDir>/prompts/<key>.md` ("." replaces ":")
3. Built-in default — `src/prompts/defaults/<key>.md`

Keys: `importantInfo` (final architectural guidance), `groupChat` (conditional @tag routing and
thought privacy), `noReply` (optional silence control, omitted in force-reply
chats), and `tool:<name>`.

## Tool documentation folders (`src/prompts/tools/<group>/`)

Every tool group has a folder with:
- `tool.md`: generic description (what the AI sees for a loaded group)
- `<function>.md`: one file per function with detailed usage

Backend groups' tool.md include: "If you have access to a backend and
frontend version of this tool, only use the backend one when explicitly asked
to." Frontend docs carry no such note. The FE may override FRONTEND groups'
tool.md text per machine (pushed with the tool config); backend group docs
are only editable here.

## Admin CLI (`npx tsx src/cli.ts`)

Run `npx tsx src/cli.ts setup` for the interactive, rerunnable first-install
wizard. It configures server exposure/trusted frontend origins, the default
model router and model, an optional first user, named API-key selection,
backend AI tool allowlists/folders, and system-prompt review. Prompt review can
open `$EDITOR` or ask a separately selected model to propose a replacement.
Non-secret server/model defaults live in `<dataDir>/setup.json`; environment
variables remain higher-priority overrides.

- user add/list — register users (auth happens on this machine by design)
  Add/reset accepts `--credential-file <path>` (or `-f`) so secrets do not
  need to appear in shell history or the process command line. Credentials
  matching exactly 4-6 digits are treated as PINs; all others are passwords.
- key set/list/get/rm — named provider API keys (keys.db)
- prompt list/show/set/rm/export/import — manage + transfer prompts
  (export/import = global DB overrides as {kind:"iris.prompts"} JSON)

## Config yaml

See docs/config.md + misc/config.example.yaml. The yaml bootstraps the config
DB once; afterwards the DB is the source of truth.
