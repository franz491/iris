import {
  applyRecoveryRetention,
  planRecoveryRetention,
  type RecoveryRetentionPlan,
  type RecoveryRoots,
} from "./recovery.js";
import { increment, setGauge, recordDuration } from "../misc/metrics.js";

export interface RecoveryRetentionPolicy {
  enabled: boolean;
  intervalMs: number;
  minimumKeep: number;
  apply: boolean;
  confirmation: string;
}
export interface RecoveryRetentionSchedulerDeps {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onError?: (error: unknown) => void;
}
export function parseRecoveryRetentionPolicy(env: NodeJS.ProcessEnv): RecoveryRetentionPolicy {
  const enabled = env.IRIS_RECOVERY_RETENTION_ENABLED === "true";
  const intervalMs = Number(env.IRIS_RECOVERY_RETENTION_INTERVAL_MS ?? 86_400_000);
  const minimumKeep = Number(env.IRIS_RECOVERY_RETENTION_MINIMUM_KEEP ?? 1);
  const apply = env.IRIS_RECOVERY_RETENTION_APPLY === "true";
  const confirmation = env.IRIS_RECOVERY_CONFIRM ?? "";
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("invalid recovery retention interval");
  if (!Number.isSafeInteger(minimumKeep) || minimumKeep < 1) throw new Error("invalid recovery retention minimum");
  if (apply && confirmation !== "RETENTION_DELETE") throw new Error("recovery retention apply confirmation required");
  return { enabled, intervalMs, minimumKeep, apply, confirmation };
}
export class RecoveryRetentionScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private stopped = false;
  constructor(
    private readonly roots: RecoveryRoots,
    private readonly policy: RecoveryRetentionPolicy,
    private readonly deps: RecoveryRetentionSchedulerDeps = {},
  ) {}
  start(
    run: () => RecoveryRetentionPlan = () =>
      planRecoveryRetention(this.roots.tempRoot, this.roots, this.policy.minimumKeep),
  ): void {
    if (!this.policy.enabled || this.stopped || this.timer) return;
    const tick = async (): Promise<void> => {
      this.timer = undefined;
      if (this.stopped || this.running) return this.schedule(tick);
      this.running = true;
      const started = Date.now();
      setGauge("recovery_retention.active", 1);
      increment("recovery_retention.runs_started");
      try {
        const plan = run();
        increment(this.policy.apply ? "recovery_retention.apply_runs" : "recovery_retention.dry_runs");
        const removed = this.policy.apply
          ? applyRecoveryRetention(plan, this.roots, false)
          : applyRecoveryRetention(plan, this.roots, true);
        increment("recovery_retention.runs_completed");
        for (let i = 0; i < removed.length / 2; i++)
          increment(this.policy.apply ? "recovery_retention.pairs_deleted" : "recovery_retention.pairs_planned");
      } catch (error) {
        increment("recovery_retention.runs_failed");
        (this.deps.onError ?? (() => undefined))(error);
      } finally {
        recordDuration("recovery_retention.duration_ms", Date.now() - started);
        setGauge("recovery_retention.active", 0);
        this.running = false;
        this.schedule(tick);
      }
    };
    void tick();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      (this.deps.clearTimer ?? clearTimeout)(this.timer);
      this.timer = undefined;
    }
  }
  private schedule(callback: () => void): void {
    if (!this.stopped) this.timer = (this.deps.setTimer ?? setTimeout)(callback, this.policy.intervalMs);
  }
}

export function startRecoveryRetentionAfterReady(
  ready: boolean,
  roots: RecoveryRoots,
  policy: RecoveryRetentionPolicy,
  deps: RecoveryRetentionSchedulerDeps = {},
): RecoveryRetentionScheduler | undefined {
  if (!ready) return undefined;
  const scheduler = new RecoveryRetentionScheduler(roots, policy, deps);
  scheduler.start();
  return scheduler;
}
