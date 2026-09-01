// cli.ts — admin CLI: user registration and API-key management.
// Run with: npx tsx src/cli.ts <command> ...
// Retention is dry-run by default; apply requires
// IRIS_RECOVERY_CONFIRM=RETENTION_DELETE and a positive minimum-keep value:
//   recovery retention TEMP_ROOT [MINIMUM_KEEP] [apply]
// Users are registered by an admin on the backend machine (per design);
// users then change their own credential/style through the API.
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const [, , cmd, sub, ...args] = process.argv;
function pathWithin(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function main(): Promise<void> {
  if (cmd === "cache" && sub === "purge") {
    const { maintainOfflineCache } = await import("./admin/cache-maintenance.js");
    const apply = args[0] === "apply";
    if (args.length > 1 || (args[0] !== undefined && !apply)) throw new Error("usage: cache purge [apply]");
    console.log(JSON.stringify(maintainOfflineCache({ apply, confirmation: process.env.IRIS_CACHE_CONFIRM })));
    return;
  }
  if (cmd === "migration" && (sub === "status" || sub === "dry-run")) {
    const { runMigrationCommand } = await import("./cli/migration.js");
    runMigrationCommand([sub], process.env);
    return;
  }
  if (cmd === "recovery" && sub !== "lost-admin") {
    const { runRecoveryCommand } = await import("./cli/recovery.js");
    await runRecoveryCommand([cmd, sub, ...args]);
    return;
  }
  if (cmd === "recovery" && (sub === "backup" || sub === "restore")) {
    const { createSqliteBackup, restoreSqliteBackup } = await import("./db/recovery.js");
    const dataRoot = process.env.IRIS_DATA_DIR;
    const tempRoot = args[0];
    const source = args[1];
    const destination = args[2];
    const validArgs = sub === "backup" ? args.length === 3 : args.length === 4;
    if (
      !dataRoot ||
      !tempRoot ||
      !source ||
      !destination ||
      !validArgs ||
      process.env.IRIS_RECOVERY_CONFIRM !== "CLOSED_HANDLES"
    ) {
      throw new Error(
        `usage: recovery ${sub} TEMP_ROOT SOURCE DESTINATION${sub === "restore" ? " MANIFEST" : ""} with IRIS_RECOVERY_CONFIRM=CLOSED_HANDLES`,
      );
    }
    const roots = { dataRoot, tempRoot };
    if (sub === "backup") console.log(JSON.stringify(await createSqliteBackup(source, destination, roots)));
    else {
      const manifestPath = args[3];
      if (!manifestPath || !pathWithin(tempRoot, manifestPath) || lstatSync(manifestPath).isSymbolicLink())
        throw new Error("manifest must be a regular file within TEMP_ROOT");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      restoreSqliteBackup(source, destination, manifest, roots, true);
      console.log("restore complete");
    }
    return;
  }

  // Keep recovery mode free of auth/database initialization.
  const { auth, validateCredential } = await import("./api/auth.js");
  if (cmd === "recovery" && sub === "lost-admin") {
    const { handleLostAdminRecovery } = await import("./cli/lost-admin.js");
    await handleLostAdminRecovery([sub, ...args].slice(1));
    return;
  }
  if (cmd === "wipe") {
    const { readdirSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { DATA_DIR } = await import("./db/sqlite.js");
    const databaseFiles = readdirSync(DATA_DIR).filter((name) => /\.db(?:-(?:shm|wal))?$/.test(name));
    for (const name of databaseFiles) unlinkSync(join(DATA_DIR, name));
    // Reset persisted configuration so the next start is a clean first run:
    // bootstrap-only setup.json plus any admin-edited prompt override files.
    const { rmSync, existsSync } = await import("node:fs");
    let removedConfig = 0;
    if (existsSync(join(DATA_DIR, "setup.json"))) {
      rmSync(join(DATA_DIR, "setup.json"));
      removedConfig++;
    }
    if (existsSync(join(DATA_DIR, "prompts"))) {
      rmSync(join(DATA_DIR, "prompts"), { recursive: true, force: true });
      removedConfig++;
    }
    console.log(
      databaseFiles.length
        ? `deleted ${databaseFiles.length} database file(s) from ${DATA_DIR}`
        : `no database files found in ${DATA_DIR}`,
    );
    console.log(
      removedConfig
        ? `deleted ${removedConfig} configuration item(s) (setup.json, prompt overrides); run 'iris setup' to configure again`
        : "no extra configuration found",
    );
    return;
  }

  if (cmd === "setup") {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    return;
  }

  if (cmd === "provider") {
    const { readSetupSettings, writeSetupSettings } = await import("./setup/settings.js");
    const settings = readSetupSettings();
    if (sub === "list") {
      for (const [name, p] of Object.entries(settings.providers))
        console.log(`${name}\t${p.router}\t${p.baseUrl}${p.apiKeyName ? `\tkey=${p.apiKeyName}` : ""}`);
      return;
    }
    if (sub === "remove" || sub === "rm") {
      const [name] = args;
      if (!name) die("usage: provider remove <name>");
      delete settings.providers[name];
      writeSetupSettings(settings);
      console.log(`removed provider ${name}`);
      return;
    }
    if (sub === "add") {
      const [name, router, baseUrl, keyName] = args;
      if (!name || !router || !baseUrl || !["openai-compat", "llamacpp"].includes(router))
        die("usage: provider add <name> <openai-compat|llamacpp> <base-url> [api-key-name]");
      settings.providers[name] = {
        router: router as "openai-compat" | "llamacpp",
        baseUrl,
        ...(keyName ? { apiKeyName: keyName } : {}),
      };
      writeSetupSettings(settings);
      console.log(`provider ${name} saved; select it as the AI router: ${name}`);
      return;
    }
    die(
      "usage: provider add <name> <openai-compat|llamacpp> <base-url> [api-key-name] | provider list | provider remove <name>",
    );
  }

  if (cmd === "user") {
    if (sub === "add") {
      const { name, credential } = readCredentialArgs(args, "user add");
      const isPin = /^\d{4,6}$/.test(credential);
      validateCredential(credential, isPin);
      // Regular signup flow executed server-side: creates user AND stores the
      // hashed credential (admin-plugin createUser leaves the account empty).
      const res = await auth.api.signUpEmail({
        body: { email: `${name}@iris.local`, password: credential, name },
      });
      const userId = (res as { user?: { id?: string } }).user?.id;
      if (!userId) die(`user creation failed: ${JSON.stringify(res)}`);
      console.log(`created user ${name} (${isPin ? "pin" : "password"}): ${userId}`);
      return;
    }
    if (sub === "list") {
      // minimal listing straight from the auth DB
      const { default: Database } = await import("better-sqlite3");
      const { dataFile } = await import("./db/sqlite.js");
      const db = new Database(dataFile("auth.db"), { readonly: true });
      const rows = db.prepare('SELECT id, name, email FROM "user"').all() as {
        id: string;
        name: string;
        email: string;
      }[];
      for (const r of rows) console.log(`${r.name}\t${r.email}\t${r.id}`);
      return;
    }
    if (sub === "reset-password") {
      const { name, credential } = readCredentialArgs(args, "user reset-password");
      const isPin = /^\d{4,6}$/.test(credential);
      validateCredential(credential, isPin);
      const { findUserByName, resetUserCredential } = await import("./api/auth.js");
      const user = findUserByName(name);
      if (!user) die(`no such user: ${name}`);
      await resetUserCredential(user.id, credential);
      console.log(`credential updated for ${name} (${isPin ? "pin" : "password"}); all sessions revoked`);
      return;
    }
    if (sub === "rename") {
      const [oldName, newName] = args;
      if (!oldName || !newName) die("usage: user rename <old> <new>");
      const { findUserByName } = await import("./api/auth.js");
      const user = findUserByName(oldName);
      if (!user) die(`no such user: ${oldName}`);
      if (findUserByName(newName)) die(`username taken: ${newName}`);
      const { default: Database } = await import("better-sqlite3");
      const { dataFile } = await import("./db/sqlite.js");
      const db = new Database(dataFile("auth.db"));
      db.prepare('UPDATE "user" SET name = ?, email = ? WHERE id = ?').run(newName, `${newName}@iris.local`, user.id);
      console.log(`${oldName} renamed to ${newName}; they now log in as ${newName}@iris.local`);
      return;
    }
    if (sub === "delete") {
      const [name] = args;
      if (!name) die("usage: user delete <name>");
      const { findUserByName } = await import("./api/auth.js");
      const user = findUserByName(name);
      if (!user) die(`no such user: ${name}`);
      const { default: Database } = await import("better-sqlite3");
      const { dataFile } = await import("./db/sqlite.js");
      const db = new Database(dataFile("auth.db"));
      // sessions + credential accounts cascade
      db.prepare('DELETE FROM "user" WHERE id = ?').run(user.id);
      console.log(
        `deleted user ${name}. Note: their chat PARTICIPANT rows remain (messages history intact) ` +
          `but hold no login anymore; remove them from chats manually if desired.`,
      );
      return;
    }
    die(
      "usage: user add <name> (<credential> | --credential-file <path>) | user list | " +
        "user reset-password <name> (<credential> | --credential-file <path>) | " +
        "user rename <old> <new> | user delete <name>",
    );
  }

  if (cmd === "key") {
    const { setApiKey, listApiKeyNames, deleteApiKey, getApiKey } = await import("./model-router/keys.js");
    if (sub === "set") {
      const [name, ...rest] = args;
      const fileIndex = rest.findIndex((arg) => arg === "--key-file" || arg === "-f");
      let key = fileIndex >= 0 ? readFileSync(rest[fileIndex + 1] ?? "", "utf8").replace(/\r?\n$/, "") : rest[0];
      if (fileIndex >= 0 && rest.length !== fileIndex + 2) die("usage: key set <name> <key|--key-file path>");
      if (!name || !key) die("usage: key set <name> <key|--key-file path>");
      setApiKey(name, key);
      console.log(`key "${name}" saved`);
      return;
    }
    if (sub === "list") {
      for (const n of listApiKeyNames()) console.log(n);
      return;
    }
    if (sub === "get") {
      const [name] = args;
      console.log(getApiKey(name ?? "")?.replace(/./g, "*") ?? "(none)");
      return;
    }
    if (sub === "rm") {
      const [name] = args;
      console.log(deleteApiKey(name ?? "") ? "deleted" : "not found");
      return;
    }
    if (sub === "rotate") {
      if (
        args.some(
          (arg) => arg.startsWith("-") && !["--current-key-file", "-c", "--new-key-file", "-n"].includes(arg),
        ) ||
        args.filter((arg) => arg === "--current-key-file" || arg === "-c").length !== 1 ||
        args.filter((arg) => arg === "--new-key-file" || arg === "-n").length !== 1 ||
        args.length !== 4
      )
        die("usage: key rotate --current-key-file path --new-key-file path");
      const currentIndex = args.findIndex((arg) => arg === "--current-key-file" || arg === "-c");
      const newIndex = args.findIndex((arg) => arg === "--new-key-file" || arg === "-n");
      if (
        currentIndex < 0 ||
        newIndex < 0 ||
        currentIndex + 1 >= args.length ||
        newIndex + 1 >= args.length ||
        currentIndex === newIndex
      )
        die("usage: key rotate --current-key-file path --new-key-file path");
      if (
        args.some(
          (arg, index) =>
            (arg === "--current-key-file" || arg === "-c" || arg === "--new-key-file" || arg === "-n") &&
            (index === args.length - 1 || args[index + 1].startsWith("-")),
        ) ||
        (currentIndex + 2 < args.length && args[currentIndex + 2].startsWith("-"))
      )
        die("usage: key rotate --current-key-file path --new-key-file path");
      if (args[currentIndex + 1] === args[newIndex + 1]) die("current and new master-key files must differ");
      const { readApiKeyMasterKeyFile } = await import("./model-router/keys.js");
      const { rotateApiKeysOperational } = await import("./db/key-rotation.js");
      const current = readApiKeyMasterKeyFile(args[currentIndex + 1]);
      const replacement = readApiKeyMasterKeyFile(args[newIndex + 1]);
      if (current.equals(replacement)) die("current and new master keys must differ");
      await rotateApiKeysOperational({
        currentKey: current,
        newKey: replacement,
        reload: async () => {
          // Revalidate the live store under the replacement before reporting
          // success; the configured key file is still operator-managed.
          process.env.IRIS_API_KEYS_MASTER_KEY = replacement.toString("base64");
          const { getApiKey, listApiKeyNames } = await import("./model-router/keys.js");
          for (const name of listApiKeyNames()) if (getApiKey(name) === null) throw new Error("key reload failed");
        },
        audit: async (status, operationId) => {
          const { auditKeyRotation } = await import("./admin/store.js");
          auditKeyRotation(status, operationId);
        },
      });
      console.log(
        "API-key master-key rotation completed; replace the configured key file only after this command succeeds",
      );
      return;
    }
    die("usage: key set|list|get|rm|rotate");
  }

  if (cmd === "prompt") {
    const { resolvePrompt, dataFilePath, ensureDataDir } = await import("./prompts/library.js");
    const { setPrompt, deletePrompt } = await import("./prompts/prompts.js");
    const { readFileSync, writeFileSync } = await import("node:fs");

    if (sub === "list") {
      // known keys: built-in defaults + anything already in the DB
      const { readdirSync } = await import("node:fs");
      const defaultsDir = new URL("./prompts/defaults/", import.meta.url).pathname;
      const keys = new Set<string>();
      try {
        for (const f of readdirSync(defaultsDir))
          if (f.endsWith(".md")) keys.add(f.replace(/\.md$/, "").replace(/\./, ":"));
      } catch {
        /* no defaults dir */
      }
      console.log([...keys].sort().join("\n"));
      return;
    }
    if (sub === "show") {
      const [key] = args;
      if (!key) die("usage: prompt show <key>");
      const v = await resolvePrompt(key);
      console.log(v ?? `(no prompt for "${key}")`);
      return;
    }
    if (sub === "set") {
      const { existsSync } = await import("node:fs");
      const [key, file] = args;
      if (!key) die("usage: prompt set <key> [file|-]   ('-' = stdin; without file, prints the md path to edit)");
      if (file === undefined) {
        ensureDataDir();
        const p = dataFilePath(key);
        if (!existsSync(p)) writeFileSync(p, "\n");
        console.log(`edit ${p} — machine override, takes effect immediately`);
        return;
      }
      const value = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
      await setPrompt(key, value.trim());
      console.log(`prompt "${key}" saved (DB override)`);
      return;
    }
    if (sub === "rm") {
      const [key] = args;
      if (!key) die("usage: prompt rm <key>");
      await deletePrompt(key);
      console.log(`DB override for "${key}" removed`);
      return;
    }
    if (sub === "export" || sub === "import") {
      const { exportPrompts, importPrompts } = await import("./prompts/transfer.js");
      const [file] = args;
      if (sub === "export") {
        const json = await exportPrompts();
        if (file) writeFileSync(file, JSON.stringify(json, null, 2));
        else console.log(JSON.stringify(json, null, 2));
        return;
      }
      let data: string;
      if (!file || file === "-") data = readFileSync(0, "utf8");
      else data = readFileSync(file, "utf8");
      const n = await importPrompts(data);
      console.log(`imported ${n} prompt(s)`);
      return;
    }
    die(
      [
        "usage:",
        "  prompt list                    list known prompt keys",
        "  prompt show <key>              print resolved prompt",
        "  prompt set <key> <file|->      store DB override from file or stdin",
        "  prompt rm <key>                remove DB override",
        "  prompt export [file]           export all DB overrides as JSON",
        "  prompt import <file|->         import prompts from JSON",
        "",
        "keys: importantInfo, groupChat, noReply, tool:<name>; files use . instead of :",
      ].join("\n"),
    );
  }

  if (cmd === "admin") {
    const { getAdminConfig, getChecklist } = await import("./admin/store.js");
    if (sub === "status") {
      console.log(JSON.stringify({ ...getAdminConfig(), checklist: getChecklist() }, null, 2));
      return;
    }
    if (sub === "discover") {
      const { discover } = await import("./admin/discovery.js");
      console.log(JSON.stringify(discover(), null, 2));
      return;
    }
    die("usage: admin status | admin discover");
  }

  die(
    [
      "iris admin CLI",
      "",
      "wipe                                         delete all Iris database files and configuration (fresh first run)",
      "provider add|list|remove                       manage named model providers",
      "setup                                         interactive first-run setup",
      "user add <name> (<credential> | --credential-file <path>)",
      "user list                                     list users",
      "key set <name> <key>                          store a named API key",
      "key list                                      list key names",
      "key rm <name>                                 delete a key",
      "prompt list|show|set|rm|export|import         manage AI prompts",
    ].join("\n"),
  );
}

function readCredentialArgs(
  args: string[],
  command: "user add" | "user reset-password",
): { name: string; credential: string } {
  const [name, ...rest] = args;
  const fileFlag = rest.findIndex((arg) => arg === "--credential-file" || arg === "-f");
  let credential: string | undefined;
  if (fileFlag >= 0) {
    const file = rest[fileFlag + 1];
    if (!file) die(`usage: ${command} <name> --credential-file <path>`);
    const remaining = rest.filter((_, index) => index !== fileFlag && index !== fileFlag + 1);
    if (remaining.length > 0) die(`too many arguments for ${command}`);
    // Text files normally end in one newline. Remove that line ending only;
    // spaces and any other credential characters remain significant.
    credential = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  } else {
    [credential] = rest;
    if (rest.length > 1) die(`too many arguments for ${command}`);
  }
  if (!name || credential === undefined) {
    die(`usage: ${command} <name> (<credential> | --credential-file <path>)`);
  }
  return { name, credential };
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

void main().then(
  () => undefined,
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
