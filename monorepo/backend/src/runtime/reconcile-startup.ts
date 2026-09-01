/** Runs durable recovery before any live projection is allowed. */
export { createReconciliationRecovery } from "./reconciliation-recovery.js";

export async function recoverBeforeProjection(
  recover: () => Promise<void>,
  project: () => Promise<void>,
): Promise<void> {
  await recover();
  await project();
}
