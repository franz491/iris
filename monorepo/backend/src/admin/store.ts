import { randomUUID } from "node:crypto";
import { z } from "zod";
import { openDb, dataFile } from "../db/sqlite.js";
import {
  adminConfig,
  redactSecrets,
  type AdminConfig,
  type AuditEntry,
  type ChecklistItem,
  type StagedPatch,
} from "./schema.js";
import { validateProfiles } from "./profiles.js";
import { readSetupSettings, writeSetupSettings } from "../setup/settings.js";
import { classifyPatch } from "./approvals.js";
import { validateTls } from "./security.js";
import { ensureService, probeService, serviceDefaults, validateServiceDefinition } from "./services.js";
import { createReconciliationRecovery } from "../runtime/reconciliation-recovery.js";

export const sqlite = openDb(dataFile("admin.db")).sqlite;
/** Bound admin audit reads so large histories cannot exhaust an admin request. */
export const MAX_AUDIT_ENTRIES = 1_000;
export function migrateAdminDb(injectFailure = false, connection = sqlite): void {
  connection.transaction(() => {
    connection.exec(
      `CREATE TABLE IF NOT EXISTS admin_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, config TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admin_patches (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, base_version INTEGER NOT NULL, patch TEXT NOT NULL, redacted_diff TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admin_patch_approvals (patch_id TEXT NOT NULL, kind TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(patch_id,kind)); CREATE TABLE IF NOT EXISTS admin_snapshots (patch_id TEXT PRIMARY KEY, version INTEGER NOT NULL, config TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admin_reconciliation_journal (patch_id TEXT PRIMARY KEY, operation TEXT NOT NULL, phase TEXT NOT NULL, prior_admin TEXT NOT NULL, applied_admin TEXT NOT NULL, prior_setup TEXT NOT NULL, applied_setup TEXT NOT NULL, intended_providers TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admin_audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, patch_id TEXT, details TEXT, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admin_checklist (id TEXT PRIMARY KEY, group_name TEXT NOT NULL, state TEXT NOT NULL);`,
    );
    if (injectFailure) throw new Error("injected admin migration failure");
    connection.exec(
      "CREATE TABLE IF NOT EXISTS admin_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    connection.prepare("INSERT OR IGNORE INTO admin_schema_migrations VALUES (1, ?)").run(new Date().toISOString());
  })();
}
migrateAdminDb();
/** Recover an interrupted apply/rollback. Recovery is deliberately conservative:
 * an incomplete operation is rolled back to its durable prior projection. */
export async function recoverReconciliationJournal(): Promise<void> {
  const recovery = createReconciliationRecovery({
    journal: {
      incomplete: () =>
        sqlite
          .prepare(
            "SELECT * FROM admin_reconciliation_journal WHERE phase IN ('prepared','setup_written','providers_applied','admin_committed','journal_terminal') ORDER BY updated_at",
          )
          .all() as never[],
      markPhase: (id, phase) => {
        sqlite
          .prepare("UPDATE admin_reconciliation_journal SET phase=?,updated_at=? WHERE patch_id=?")
          .run(phase, now(), id);
      },
    },
    admin: {
      currentVersion: () => getAdminConfig().version,
      restore: (config, version) => {
        sqlite
          .prepare("UPDATE admin_state SET version=?,config=?,updated_at=? WHERE id=1")
          .run(version, JSON.stringify(config), now());
      },
    },
    setup: { write: writeSetupSettings },
    projectProviders: async (config) => {
      const [{ getConfig }, { kernel }, { providerFunctionalities }] = await Promise.all([
        import("../runtime/config-parser.js"),
        import("../runtime/kernel.js"),
        import("../chat/tools.js"),
      ]);
      const runtime = await getConfig();
      const providers = Object.entries(config.tools).map(([name, tool]) => ({
        name,
        activeFunctionalities: providerFunctionalities(name, tool.active),
        additionalSettings: {
          ...(runtime[name]?.additionalSettings ?? {}),
          aiAllowedFunctionalities: providerFunctionalities(name, name === "files" ? tool.allowed : tool.active),
        },
      }));
      if (providers.length) await kernel.setConfig(providers);
    },
  });
  await recovery();
}
const now = () => new Date().toISOString();
const approvalRow = z.object({ kind: z.string() });
const patchStatusSchema = z.enum(["staged", "validated", "tested", "applied", "rolled-back", "rejected"]);
const approvalKindSchema = z.enum(["standard", "network", "download"]);
type ApprovalKind = z.infer<typeof approvalKindSchema>;
const approvalMetadataSchema = z
  .object({
    _approvals: z
      .object({
        required: z.array(approvalKindSchema),
        reasons: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .passthrough();
const requiredApprovals = (redactedDiff: unknown, fallback: readonly ApprovalKind[]): ApprovalKind[] => {
  const parsed = approvalMetadataSchema.parse(redactedDiff);
  return parsed._approvals?.required ?? [...fallback];
};
const persistedPatchRowSchema = z
  .object({
    id: z.string(),
    actor_id: z.string(),
    base_version: z.number().int(),
    patch: z.string(),
    redacted_diff: z.string(),
    status: patchStatusSchema,
    created_at: z.string(),
  })
  .strict();
const persistedAdminConfigRowSchema = z
  .object({
    version: z.number().int(),
    config: z.string(),
  })
  .strict();
const redactedDiffSchema = adminConfig
  .extend({
    _approvals: z
      .object({
        required: z.array(approvalKindSchema),
        reasons: z.array(z.string()),
      })
      .strict(),
  })
  .passthrough();
const parsePersistedJson = (value: string, field: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`malformed persisted patch ${field}`);
  }
};
const parsePersistedAdminConfig = (row: unknown): { version: number; config: AdminConfig } => {
  const parsedRow = persistedAdminConfigRowSchema.parse(row);
  let value: unknown;
  try {
    value = JSON.parse(parsedRow.config);
  } catch {
    throw new Error("malformed persisted admin config");
  }
  return { version: parsedRow.version, config: adminConfig.parse(value) };
};
type ChecklistRow = { id: string; group_name: string; state: ChecklistItem["state"] };
const checklistStateSchema = z.enum(["not configured", "configured but untested", "verified", "explicitly skipped"]);
const checklistRowSchema: z.ZodType<ChecklistRow> = z
  .object({
    id: z.string(),
    group_name: z.string(),
    state: checklistStateSchema,
  })
  .strict();
const parseChecklistRow = (row: unknown): ChecklistRow => checklistRowSchema.parse(row);
const auditRowSchema = z
  .object({
    id: z.string(),
    actor_id: z.string(),
    action: z.string(),
    patch_id: z.string().nullable(),
    details: z.string(),
    created_at: z.string(),
  })
  .strict();
const auditDetailsSchema = z.record(z.unknown());
const parseAuditRow = (row: unknown): AuditEntry => {
  const parsed = auditRowSchema.parse(row);
  let details: unknown;
  try {
    details = JSON.parse(parsed.details);
  } catch {
    throw new Error("malformed persisted audit details");
  }
  // Re-redact on read as a defence-in-depth boundary for legacy rows and
  // future writers. The audit endpoint is also the export surface.
  const redacted = redactSecrets(auditDetailsSchema.parse(details));
  return {
    id: parsed.id,
    actorId: parsed.actor_id,
    action: parsed.action,
    patchId: parsed.patch_id ?? undefined,
    details:
      redacted && typeof redacted === "object" && !Array.isArray(redacted) ? (redacted as Record<string, unknown>) : {},
    createdAt: parsed.created_at,
  };
};
const CHECKLIST = [
  ["foundation", "foundation/security"],
  ["administrator", "administrator/sessions"],
  ["llm", "LLM runtime/model test"],
  ["speech", "TTS/STT decision and test"],
  ["resources", "resource contention policy"],
  ["tools", "tool internal access"],
  ["allowlist", "AI allowlists"],
  ["boundaries", "approvals/folder boundaries"],
  ["prompts", "core/tool prompts"],
  ["voices", "voice preview/cloning policy"],
  ["cache", "cache policy"],
] as const;
for (const [id, group] of CHECKLIST)
  sqlite.prepare("INSERT OR IGNORE INTO admin_checklist VALUES (?,?,?)").run(id, group, "not configured");
const initial: AdminConfig = {
  schemaVersion: 1,
  server: {
    host: "127.0.0.1",
    port: 3000,
    publicUrl: "http://localhost:3000",
    trustedOrigins: [],
    tls: { mode: "localhost-only" },
  },
  services: Object.values(serviceDefaults()),
  profiles: [],
  secrets: {},
  tools: {},
  prompts: {},
  cache: { enabled: false, maxAgeSeconds: 0, maxBytes: 0 },
};
export function resetAdminConfig(actorId: string): AdminConfig {
  const current = getAdminConfig();
  const next = { ...structuredClone(initial), server: current.config.server, secrets: current.config.secrets };
  sqlite
    .prepare("UPDATE admin_state SET version=?,config=?,updated_at=? WHERE id=1")
    .run(current.version + 1, JSON.stringify(next), now());
  const legacy = readSetupSettings();
  writeSetupSettings({ ...legacy, defaultModel: { ...legacy.defaultModel, model: "" } });
  audit(actorId, "config.reset_defaults");
  return next;
}
function legacySeed(): AdminConfig {
  const s = readSetupSettings();
  return {
    ...initial,
    server: {
      host: s.server.host,
      port: s.server.port,
      publicUrl: s.server.publicUrl,
      trustedOrigins: s.server.trustedOrigins,
      tls: { mode: "localhost-only" },
    },
    profiles: [],
    secrets: Object.fromEntries(
      Object.values(s.providers)
        .filter((p) => p.apiKeyName)
        .map((p) => [p.apiKeyName!, "configured"]),
    ),
  };
}
export function getAdminConfig(): { version: number; config: AdminConfig } {
  const row = sqlite.prepare("SELECT version, config FROM admin_state WHERE id=1").get();
  if (!row) {
    const seeded = legacySeed();
    sqlite.prepare("INSERT INTO admin_state VALUES (1,1,?,?)").run(JSON.stringify(seeded), now());
    return { version: 1, config: seeded };
  }
  return parsePersistedAdminConfig(row);
}
function audit(actorId: string, action: string, patchId?: string, details?: unknown): AuditEntry {
  const redacted = redactSecrets(details);
  const entry: AuditEntry = {
    id: randomUUID(),
    actorId,
    action,
    patchId,
    details:
      redacted && typeof redacted === "object" && !Array.isArray(redacted)
        ? (redacted as Record<string, unknown>)
        : undefined,
    createdAt: now(),
  };
  sqlite
    .prepare("INSERT INTO admin_audit VALUES (?,?,?,?,?,?)")
    .run(entry.id, actorId, action, patchId ?? null, JSON.stringify(entry.details ?? {}), entry.createdAt);
  return entry;
}
export function listAudit(limit = MAX_AUDIT_ENTRIES): AuditEntry[] {
  const boundedLimit = Math.max(1, Math.min(MAX_AUDIT_ENTRIES, Math.floor(limit)));
  return sqlite
    .prepare("SELECT * FROM admin_audit ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(boundedLimit)
    .map(parseAuditRow);
}
export function stagePatch(actorId: string, patch: unknown): StagedPatch {
  const current = getAdminConfig();
  const parsed = adminConfig.parse(patch);
  const errors = [
    ...validateProfiles(parsed),
    ...validateTls({ ...parsed.server.tls, trustedOrigins: parsed.server.trustedOrigins }),
    ...parsed.services.flatMap(validateServiceDefinition),
  ];
  if (errors.length) throw new Error(errors.join("; "));
  const approvals = classifyPatch(parsed, current.config);
  const result: StagedPatch = {
    id: randomUUID(),
    actorId,
    baseVersion: current.version,
    patch: parsed,
    redactedDiff: { ...(redactSecrets(parsed) as object), _approvals: approvals },
    status: "staged",
    createdAt: now(),
  };
  sqlite
    .prepare("INSERT INTO admin_patches VALUES (?,?,?,?,?,?,?)")
    .run(
      result.id,
      actorId,
      result.baseVersion,
      JSON.stringify(parsed),
      JSON.stringify(result.redactedDiff),
      result.status,
      result.createdAt,
    );
  audit(actorId, "patch.staged", result.id, approvals);
  return result;
}
export function getPatch(id: string): StagedPatch | null {
  const row = sqlite.prepare("SELECT * FROM admin_patches WHERE id=?").get(id);
  if (!row) return null;
  const r = persistedPatchRowSchema.parse(row);
  const patch = adminConfig.parse(parsePersistedJson(r.patch, "patch"));
  const redactedDiff = redactedDiffSchema.parse(parsePersistedJson(r.redacted_diff, "redacted diff"));
  return {
    id: r.id,
    actorId: r.actor_id,
    baseVersion: r.base_version,
    patch,
    redactedDiff,
    status: r.status,
    createdAt: r.created_at,
  };
}
export function validatePatch(id: string, actorId: string, test = false): StagedPatch {
  const p = getPatch(id);
  if (!p || p.actorId !== actorId) throw new Error("patch not found");
  const current = getAdminConfig();
  if (p.baseVersion !== current.version) throw new Error("patch is stale");
  adminConfig.parse(p.patch);
  const status = test ? "tested" : "validated";
  sqlite.prepare("UPDATE admin_patches SET status=? WHERE id=?").run(status, id);
  audit(actorId, `patch.${status}`, id);
  return { ...p, status };
}
export async function testPatch(id: string, actorId: string, signal?: AbortSignal): Promise<StagedPatch> {
  const p = validatePatch(id, actorId, false);
  const config = adminConfig.parse(p.patch);
  const results = await Promise.all(
    config.services.map(async (service) =>
      service.mode === "connect-only" ? probeService(service) : (await ensureService(service, signal)).readiness,
    ),
  );
  const failed = results.filter((x) => !x.reachable);
  if (failed.length) throw new Error(failed.map((x) => `${x.name}: ${x.detail}`).join("; "));
  sqlite.prepare("UPDATE admin_patches SET status='tested' WHERE id=?").run(id);
  audit(actorId, "patch.tested", id, { services: results });
  return { ...p, status: "tested" };
}
export function approvePatch(id: string, actorId: string, kind: string): void {
  const p = getPatch(id);
  if (!p) throw new Error("patch not found");
  const approvals = requiredApprovals(p.redactedDiff, []);
  if (!approvals.some((approval) => approval === kind)) throw new Error("approval category is not required");
  sqlite.prepare("INSERT OR REPLACE INTO admin_patch_approvals VALUES (?,?,?,?)").run(id, kind, actorId, now());
  audit(actorId, "patch.approved", id, { kind });
}
let applyLock: Promise<void> = Promise.resolve();
export type PersistBoundary = (boundaryName: string) => void | Promise<void>;
export async function applyPatch(
  id: string,
  actorId: string,
  faultAt: PersistBoundary = () => undefined,
): Promise<StagedPatch> {
  const prior = applyLock;
  let release!: () => void;
  applyLock = new Promise<void>((resolve) => (release = resolve));
  await prior;
  try {
    return await applyPatchUnlocked(id, actorId, faultAt);
  } finally {
    release();
  }
}
async function applyPatchUnlocked(id: string, actorId: string, faultAt: PersistBoundary): Promise<StagedPatch> {
  const p = getPatch(id);
  if (!p || p.actorId !== actorId || !["validated", "tested"].includes(p.status))
    throw new Error("patch must be validated before apply");
  const current = getAdminConfig();
  if (p.baseVersion !== current.version) throw new Error("patch is stale");
  const required = requiredApprovals(p.redactedDiff, ["standard"]);
  const approved = new Set(
    sqlite
      .prepare("SELECT kind FROM admin_patch_approvals WHERE patch_id=?")
      .all(id)
      .map((row) => approvalRow.parse(row).kind),
  );
  if (required.some((x) => x !== "standard" && !approved.has(x))) throw new Error("required approval is missing");
  sqlite
    .prepare("INSERT OR REPLACE INTO admin_snapshots VALUES (?,?,?)")
    .run(
      id,
      current.version,
      JSON.stringify({ version: 1, adminConfig: current.config, setupSettings: readSetupSettings() }),
    );
  const next = p.patch as AdminConfig;
  const legacy = readSetupSettings();
  const journal = (phase: string) =>
    sqlite
      .prepare("UPDATE admin_reconciliation_journal SET phase=?,updated_at=? WHERE patch_id=?")
      .run(phase, now(), id);
  sqlite
    .prepare("INSERT OR REPLACE INTO admin_reconciliation_journal VALUES (?,?,?,?,?,?,?,?,?)")
    .run(
      id,
      "apply",
      "prepared",
      JSON.stringify({ version: current.version, config: current.config }),
      JSON.stringify({ version: current.version + 1, config: next }),
      JSON.stringify(legacy),
      "",
      "[]",
      now(),
    );
  await faultAt("journal_prepared");
  const restoreLegacy = () => writeSetupSettings(legacy);
  try {
    writeSetupSettings({
      ...legacy,
      server: {
        ...legacy.server,
        host: next.server.host,
        port: next.server.port,
        publicUrl: next.server.publicUrl,
        trustedOrigins: next.server.trustedOrigins,
      },
      defaultModel: {
        ...legacy.defaultModel,
        model: next.profiles.find((x) => x.name === "default")?.model ?? legacy.defaultModel.model,
      },
    });
    await faultAt("setup_written");
  } catch (error) {
    try {
      restoreLegacy();
    } catch {
      /* preserve fault */
    }
    throw error;
  }
  const [{ getConfig }, { kernel }, { providerFunctionalities }] = await Promise.all([
    import("../runtime/config-parser.js"),
    import("../runtime/kernel.js"),
    import("../chat/tools.js"),
  ]);
  const runtime = await getConfig();
  const providerConfigs = Object.entries(next.tools).map(([name, tool]) => {
    const active = providerFunctionalities(name, tool.active);
    const allowed = providerFunctionalities(name, name === "files" ? tool.allowed : tool.active);
    return {
      name,
      activeFunctionalities: active,
      additionalSettings: { ...(runtime[name]?.additionalSettings ?? {}), aiAllowedFunctionalities: allowed },
    };
  });
  let adminCommitted = false;
  sqlite
    .prepare(
      "UPDATE admin_reconciliation_journal SET applied_setup=?,intended_providers=?,updated_at=? WHERE patch_id=?",
    )
    .run(
      JSON.stringify({
        ...legacy,
        server: {
          ...legacy.server,
          host: next.server.host,
          port: next.server.port,
          publicUrl: next.server.publicUrl,
          trustedOrigins: next.server.trustedOrigins,
        },
        defaultModel: {
          ...legacy.defaultModel,
          model: next.profiles.find((x) => x.name === "default")?.model ?? legacy.defaultModel.model,
        },
      }),
      JSON.stringify(providerConfigs),
      now(),
      id,
    );
  journal("setup_written");
  try {
    if (providerConfigs.length) await kernel.setConfig(providerConfigs);
    await faultAt("providers_projected");
    journal("providers_applied");
    sqlite
      .prepare("UPDATE admin_state SET version=?,config=?,updated_at=? WHERE id=1")
      .run(current.version + 1, JSON.stringify(p.patch), now());
    sqlite.prepare("UPDATE admin_patches SET status='applied' WHERE id=?").run(id);
    journal("admin_committed");
    adminCommitted = true;
    await faultAt("admin_committed");
    await faultAt("journal_terminal");
    journal("committed");
  } catch (error) {
    if (adminCommitted) throw error;
    journal("failed");
    // Setup settings are persisted before runtime reconciliation. Restore them
    // if probing/apply or the state commit fails so a failed apply cannot leave
    // setup and admin projections disagreeing.
    try {
      restoreLegacy();
    } catch {
      // Preserve the original apply failure; startup will still read the
      // unchanged admin snapshot on the next attempt.
    }
    throw error;
  }
  audit(actorId, "patch.applied", id);
  return { ...p, status: "applied" };
}
export async function rollback(
  actorId: string,
  patchId: string,
  deps: { reconcileProviders?: () => Promise<void>; faultAt?: PersistBoundary } = {},
): Promise<StagedPatch> {
  const p = getPatch(patchId);
  const snapshot = sqlite.prepare("SELECT version,config FROM admin_snapshots WHERE patch_id=?").get(patchId) as
    { version: number; config: string } | undefined;
  const current = getAdminConfig();
  if (!p || p.status !== "applied" || !snapshot) throw new Error("applied patch snapshot not found");
  let priorConfig: AdminConfig;
  let priorSetup: ReturnType<typeof readSetupSettings> | undefined;
  try {
    const envelope = JSON.parse(snapshot.config) as {
      adminConfig?: unknown;
      setupSettings?: ReturnType<typeof readSetupSettings>;
    };
    priorConfig = adminConfig.parse(envelope.adminConfig ?? envelope);
    priorSetup = envelope.setupSettings;
  } catch {
    priorConfig = adminConfig.parse(JSON.parse(snapshot.config));
  }
  const appliedSetup = readSetupSettings();
  sqlite
    .prepare("INSERT OR REPLACE INTO admin_reconciliation_journal VALUES (?,?,?,?,?,?,?,?,?)")
    .run(
      patchId,
      "rollback",
      "prepared",
      JSON.stringify({ version: current.version, config: current.config }),
      JSON.stringify(priorConfig),
      JSON.stringify(appliedSetup),
      JSON.stringify(priorSetup ?? appliedSetup),
      "[]",
      now(),
    );
  try {
    if (priorSetup) writeSetupSettings(priorSetup);
    await deps.faultAt?.("rollback_setup_written");
  } catch (error) {
    try {
      writeSetupSettings(appliedSetup);
    } catch {
      /* preserve original fault */
    }
    throw error;
  }
  const [{ getConfig }, { kernel }, { providerFunctionalities }] = await Promise.all([
    import("../runtime/config-parser.js"),
    import("../runtime/kernel.js"),
    import("../chat/tools.js"),
  ]);
  const runtime = await getConfig();
  const providerConfigs = Object.entries(priorConfig.tools).map(([name, tool]) => ({
    name,
    activeFunctionalities: providerFunctionalities(name, tool.active),
    additionalSettings: {
      ...(runtime[name]?.additionalSettings ?? {}),
      aiAllowedFunctionalities: providerFunctionalities(name, name === "files" ? tool.allowed : tool.active),
    },
  }));
  let adminCommitted = false;
  try {
    if (deps.reconcileProviders) await deps.reconcileProviders();
    else if (providerConfigs.length) await kernel.setConfig(providerConfigs);
    await deps.faultAt?.("rollback_providers_projected");
    sqlite
      .prepare("UPDATE admin_reconciliation_journal SET phase=?,updated_at=? WHERE patch_id=?")
      .run("providers_applied", now(), patchId);
    sqlite
      .prepare("UPDATE admin_state SET version=?,config=?,updated_at=? WHERE id=1")
      .run(current.version + 1, JSON.stringify(priorConfig), now());
    sqlite.prepare("UPDATE admin_patches SET status='rolled-back' WHERE id=?").run(patchId);
    sqlite
      .prepare("UPDATE admin_reconciliation_journal SET phase=?,updated_at=? WHERE patch_id=?")
      .run("admin_committed", now(), patchId);
    adminCommitted = true;
    await deps.faultAt?.("rollback_admin_committed");
    await deps.faultAt?.("rollback_journal_terminal");
    sqlite
      .prepare("UPDATE admin_reconciliation_journal SET phase=?,updated_at=? WHERE patch_id=?")
      .run("committed", now(), patchId);
  } catch (error) {
    if (adminCommitted) throw error;
    sqlite
      .prepare("UPDATE admin_reconciliation_journal SET phase=?,updated_at=? WHERE patch_id=?")
      .run("failed", now(), patchId);
    try {
      writeSetupSettings(appliedSetup);
    } catch {
      // Preserve the original reconciliation failure.
    }
    throw error;
  }
  audit(actorId, "patch.rolled_back", patchId);
  return { ...p, status: "rolled-back" };
}
export function getChecklist(): ChecklistItem[] {
  return sqlite
    .prepare("SELECT id,group_name,state FROM admin_checklist ORDER BY id")
    .all()
    .map((row) => {
      const parsed = parseChecklistRow(row);
      return { id: parsed.id, group: parsed.group_name, state: parsed.state };
    });
}
export function setChecklistState(id: string, state: ChecklistItem["state"]): ChecklistItem {
  if (!CHECKLIST.some(([key]) => key === id)) throw new Error("unknown checklist item");
  const parsedState = checklistStateSchema.parse(state);
  sqlite.prepare("UPDATE admin_checklist SET state=? WHERE id=?").run(parsedState, id);
  const row = parseChecklistRow(sqlite.prepare("SELECT id,group_name,state FROM admin_checklist WHERE id=?").get(id));
  return { id: row.id, group: row.group_name, state: row.state };
}
export type UserAuditAction =
  "role_changed" | "sessions_revoked" | "password_reset" | "user_deleted" | "lost_admin_recovery";
export function auditUserMutation(
  actorId: string,
  targetId: string,
  action: UserAuditAction,
  outcome: "success" | "failure" = "success",
): AuditEntry {
  return audit(actorId, `user.${action}`, undefined, { targetId, outcome });
}

/** Bounded operational record for key rotation; never accepts key material. */
export function auditKeyRotation(status: "started" | "completed" | "failed", operationId: string): AuditEntry {
  if (!/^[0-9a-f-]{36}$/.test(operationId)) throw new Error("invalid key-rotation operation id");
  return audit("system", `key_rotation.${status}`, undefined, { operationId, outcome: status });
}
