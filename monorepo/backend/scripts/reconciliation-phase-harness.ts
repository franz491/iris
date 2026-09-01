import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AdminConfig } from "../src/admin/schema.js";
import { createReconciliationRecovery } from "../src/runtime/reconciliation-recovery.js";
import { recoverBeforeProjection } from "../src/runtime/reconcile-startup.js";
import type { ProviderConfig } from "../src/runtime/types.js";

const root = process.env.IRIS_PHASE_ROOT;
const phase = process.argv[2] === "--" ? process.argv[3] : process.argv[2];
if (!root || !phase || !path.resolve(root).startsWith("/tmp/iris-reconciliation-phase"))
  throw new Error("IRIS_PHASE_ROOT must be an explicit /tmp/iris-reconciliation-phase-* directory");
if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error("IRIS_PHASE_ROOT must not be a symlink");
mkdirSync(root, { recursive: true });
process.env.IRIS_DATA_DIR = root;
const { sqlite } = await import("../src/admin/store.js");
const db = sqlite;
const prior: AdminConfig = {
  schemaVersion: 1,
  server: {
    host: "127.0.0.1",
    port: 3000,
    publicUrl: "http://localhost:3000",
    trustedOrigins: [],
    tls: { mode: "localhost-only" },
  },
  services: [],
  profiles: [],
  secrets: {},
  tools: {},
  prompts: {},
  cache: { enabled: false, maxAgeSeconds: 0, maxBytes: 0 },
};
const setup = { version: 1, marker: "prior", server: { port: 3000 } };
const appliedSetup = { version: 1, marker: "applied", server: { port: 4000 } };
const applied: AdminConfig = {
  ...prior,
  server: { ...prior.server, port: 4000 },
  tools: { files: { active: ["read"], allowed: ["read", "write"] } },
};
const configJson = JSON.stringify({ version: 7, config: prior });
function file(name: string) {
  return path.join(root!, name);
}
function recovery() {
  return createReconciliationRecovery({
    journal: {
      incomplete: () =>
        db
          .prepare(
            "SELECT patch_id,phase,prior_admin,prior_setup FROM admin_reconciliation_journal WHERE phase NOT IN ('committed','recovered') ORDER BY patch_id",
          )
          .all() as never[],
      markPhase: (id, phase) => {
        db.prepare("UPDATE admin_reconciliation_journal SET phase=?,updated_at=? WHERE patch_id=?").run(
          phase,
          new Date().toISOString(),
          id,
        );
      },
    },
    admin: {
      currentVersion: () =>
        (db.prepare("SELECT version FROM admin_state WHERE id=1").get() as { version: number }).version,
      restore: (config, version) => {
        db.prepare("UPDATE admin_state SET version=?,config=? WHERE id=1").run(version, JSON.stringify(config));
      },
    },
    setup: { write: (value) => writeFileSync(file("setup.json"), JSON.stringify(value)) },
    projectProviders: async (config) => {
      if (process.env.IRIS_PHASE_FAIL_RECOVER === "1") throw new Error("injected provider failure");
      const providers: ProviderConfig[] = Object.entries(config.tools).map(([name, tool]) => ({
        name,
        activeFunctionalities: tool.active,
        additionalSettings: { aiAllowedFunctionalities: name === "files" ? tool.allowed : tool.active },
      }));
      writeFileSync(file("providers.json"), JSON.stringify(providers));
    },
  })();
}
if (phase === "seed" || phase === "seed-failure") {
  for (const name of ["normal_projection", "startup_blocked"]) if (existsSync(file(name))) rmSync(file(name));
  db.prepare("INSERT OR REPLACE INTO admin_state VALUES (1,8,?,?)").run(
    JSON.stringify(applied),
    new Date().toISOString(),
  );
  db.prepare("INSERT OR REPLACE INTO admin_reconciliation_journal VALUES (?,?,?,?,?,?,?,?,?)").run(
    "phase-1",
    "apply",
    "providers_applied",
    configJson,
    JSON.stringify({ version: 8, config: applied }),
    JSON.stringify(setup),
    JSON.stringify(appliedSetup),
    "[]",
    new Date().toISOString(),
  );
  writeFileSync(file("setup.json"), JSON.stringify(appliedSetup));
  writeFileSync(
    file("providers.json"),
    JSON.stringify([
      {
        name: "files",
        activeFunctionalities: ["read"],
        additionalSettings: { aiAllowedFunctionalities: ["read", "write"] },
      },
    ]),
  );
} else if (phase === "recover" || phase === "recover-again" || phase === "fail-recover") {
  if (phase === "fail-recover") {
    rmSync(file("setup.json"));
    mkdirSync(file("setup.json"));
  }
  try {
    await recoverBeforeProjection(recovery, async () => writeFileSync(file("normal_projection"), "projected"));
  } catch (error) {
    writeFileSync(file("startup_blocked"), String(error));
    throw error;
  }
} else if (phase === "verify" || phase === "verify-failure") {
  const row = db.prepare("SELECT phase FROM admin_reconciliation_journal WHERE patch_id='phase-1'").get() as {
    phase: string;
  };
  let setupNow: { marker?: string } = {};
  try {
    setupNow = JSON.parse(readFileSync(file("setup.json"), "utf8"));
  } catch {
    /* failure fixture intentionally blocks setup restore */
  }
  const state = JSON.parse(
    (db.prepare("SELECT config FROM admin_state WHERE id=1").get() as { config: string }).config,
  );
  const providers = JSON.parse(readFileSync(file("providers.json"), "utf8"));
  const serverDrill = existsSync(file("chat.db"));
  const journalIntent = JSON.parse(
    (
      db.prepare("SELECT intended_providers FROM admin_reconciliation_journal WHERE patch_id='phase-1'").get() as {
        intended_providers: string;
      }
    ).intended_providers,
  );
  const expected =
    phase === "verify"
      ? row.phase === "recovered" &&
        setupNow.marker === "prior" &&
        JSON.stringify(state) === JSON.stringify(prior) &&
        (serverDrill
          ? JSON.stringify(journalIntent) === JSON.stringify([])
          : JSON.stringify(providers) === JSON.stringify([]))
      : row.phase === "recovery_failed" &&
        existsSync(file("startup_blocked")) &&
        !existsSync(file("normal_projection"));
  if (!expected) throw new Error(`verification failed: phase=${row.phase}, setup=${setupNow.marker}`);
} else throw new Error(`unknown phase ${phase}`);
db.close();
