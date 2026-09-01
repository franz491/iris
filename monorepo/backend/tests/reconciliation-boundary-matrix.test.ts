import { describe, expect, it } from "vitest";
import {
  createReconciliationRecovery,
  type ReconciliationJournalEntry,
} from "../src/runtime/reconciliation-recovery.js";
import type { AdminConfig } from "../src/admin/schema.js";

const config = (port: number): AdminConfig => ({
  schemaVersion: 1,
  server: {
    host: "127.0.0.1",
    port,
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
});
const setup = (port: number) => ({ version: 1, server: { port }, marker: port === 3000 ? "prior" : "applied" });
const cases = [
  ["apply", "prepared", "prior"],
  ["apply", "setup_written", "prior"],
  ["apply", "providers_applied", "prior"],
  ["apply", "admin_committed", "applied"],
  ["apply", "journal_terminal", "applied"],
  ["rollback", "prepared", "prior"],
  ["rollback", "rollback_setup_written", "prior"],
  ["rollback", "rollback_providers_projected", "prior"],
  ["rollback", "admin_committed", "prior"],
] as const;

describe("reconciliation persist-boundary recovery matrix", () => {
  it.each(cases)("%s at %s selects %s projection", async (operation, phase, expected) => {
    const row: ReconciliationJournalEntry & { operation: "apply" | "rollback" } = {
      patch_id: "p",
      operation,
      phase,
      prior_admin: JSON.stringify({ version: 1, config: config(3000) }),
      applied_admin: JSON.stringify({ version: 2, config: config(4000) }),
      prior_setup: JSON.stringify(setup(3000)),
      applied_setup: JSON.stringify(setup(4000)),
    };
    let current = config(4000);
    let currentSetup = setup(4000);
    let journal = phase;
    let projections = 0;
    const recover = createReconciliationRecovery({
      journal: {
        incomplete: () => (["committed", "recovered"].includes(journal) ? [] : [row]),
        markPhase: (_id, value) => {
          journal = value;
        },
      },
      admin: {
        currentVersion: () => 2,
        restore: (value) => {
          current = value;
        },
      },
      setup: {
        write: (value) => {
          currentSetup = value;
        },
      },
      projectProviders: () => {
        projections++;
      },
    });
    await recover();
    await recover();
    expect(current.server.port).toBe(expected === "prior" ? 3000 : 4000);
    expect(currentSetup.marker).toBe(expected);
    expect(journal).toBe("recovered");
    expect(projections).toBe(1);
  });

  it.each(["committed", "recovered", "failed", "recovery_failed"])(
    "does not replay terminal phase %s",
    async (phase) => {
      let projections = 0;
      const recover = createReconciliationRecovery({
        journal: { incomplete: () => [], markPhase: () => undefined },
        admin: { currentVersion: () => 1, restore: () => undefined },
        setup: { write: () => undefined },
        projectProviders: () => {
          projections++;
        },
      });
      await recover();
      expect(projections).toBe(0);
    },
  );
});
