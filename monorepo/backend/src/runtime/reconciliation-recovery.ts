import { adminConfig, type AdminConfig } from "../admin/schema.js";
import type { SetupSettings } from "../setup/settings.js";

export interface ReconciliationJournalEntry {
  patch_id: string;
  operation: "apply" | "rollback";
  phase: string;
  prior_admin: string;
  applied_admin: string;
  prior_setup: string;
  applied_setup: string;
}

/** Storage and projection boundary used by durable reconciliation recovery. */
export interface ReconciliationRecoveryDependencies {
  journal: {
    incomplete(): ReconciliationJournalEntry[] | Promise<ReconciliationJournalEntry[]>;
    markPhase(patchId: string, phase: string): void | Promise<void>;
  };
  admin: {
    restore(config: AdminConfig, version: number): void | Promise<void>;
    currentVersion(): number;
  };
  setup: {
    write(settings: SetupSettings): void | Promise<void>;
  };
  projectProviders(config: AdminConfig): void | Promise<void>;
}

/**
 * Creates the actual journal replay operation.  It has no singleton or DB
 * imports, which makes recovery deterministic in startup and standalone tests.
 */
export function createReconciliationRecovery(deps: ReconciliationRecoveryDependencies) {
  return async function recover(): Promise<void> {
    const terminal = new Set(["committed", "recovered", "failed", "recovery_failed"]);
    for (const row of (await deps.journal.incomplete()).filter((entry) => !terminal.has(entry.phase))) {
      try {
        const rollForward =
          (row.operation === "apply" && ["admin_committed", "journal_terminal"].includes(row.phase)) ||
          (row.operation === "rollback" && ["admin_committed", "journal_terminal"].includes(row.phase));
        const adminRaw = rollForward && row.operation === "apply" ? row.applied_admin : row.prior_admin;
        const setupRaw = rollForward && row.operation === "apply" ? row.applied_setup : row.prior_setup;
        const envelope = JSON.parse(adminRaw) as { version?: number; config?: unknown };
        const config = adminConfig.parse(envelope.config ?? envelope);
        const setup = JSON.parse(setupRaw) as SetupSettings;
        await deps.setup.write(setup);
        await deps.projectProviders(config);
        await deps.admin.restore(config, envelope.version ?? deps.admin.currentVersion());
        await deps.journal.markPhase(row.patch_id, "recovered");
      } catch (error) {
        await deps.journal.markPhase(row.patch_id, "recovery_failed");
        throw new Error(`reconciliation recovery failed for ${row.patch_id}: ${String(error)}`);
      }
    }
  };
}
