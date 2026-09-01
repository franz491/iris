import { increment, setGauge } from "../misc/metrics.js";

export type FrontendToolWaitResult = { approved: boolean; result?: unknown; error?: string };

export interface FrontendToolWaitRequest {
  userId: string;
  clientId: string;
  timeoutMs: number;
  signal: AbortSignal;
  emit: (requestId: string) => void;
}

type PendingEntry = {
  resolve: (result: FrontendToolWaitResult) => void;
  timer: NodeJS.Timeout | null;
  abortCleanup: (() => void) | null;
  userId: string;
  clientId: string;
};

export interface FrontendToolWaitMetrics {
  onTimeout?: (timeoutMs: number) => void;
}

/** Owns the lifecycle of one-shot frontend-tool approval requests. */
export class FrontendToolWaitRegistry {
  private readonly pending = new Map<string, PendingEntry>();

  constructor(
    private readonly createRequestId: () => string,
    private readonly metrics: FrontendToolWaitMetrics = {},
  ) {}

  get size(): number {
    return this.pending.size;
  }

  wait(request: FrontendToolWaitRequest): { requestId: string; promise: Promise<FrontendToolWaitResult> } {
    // Request ids are normally UUIDs, but keep the registry safe if an
    // injected generator repeats an id (or a future implementation does).
    // Never overwrite a live wait: doing so would strand its promise and make
    // the old request unresolvable.
    let requestId = this.createRequestId();
    for (let attempt = 1; attempt < 16 && this.pending.has(requestId); attempt++) {
      requestId = this.createRequestId();
    }
    if (this.pending.has(requestId)) {
      return {
        requestId,
        promise: Promise.resolve({ approved: false, error: "could not allocate a unique tool request id" }),
      };
    }
    const promise = new Promise<FrontendToolWaitResult>((resolve) => {
      const onAbort = () => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.remove(requestId, pending);
        increment("tool_waits.cancelled");
        resolve({ approved: false, error: "generation cancelled" });
      };
      const abortCleanup = () => request.signal.removeEventListener("abort", onAbort);
      const timer =
        request.timeoutMs > 0
          ? setTimeout(() => {
              const pending = this.pending.get(requestId);
              if (!pending) return;
              this.remove(requestId, pending);
              increment("tool_waits.timed_out");
              // Metrics/observability hooks are auxiliary: a logger or
              // injected test sink must never strand the tool-loop promise.
              try {
                this.metrics.onTimeout?.(request.timeoutMs);
              } catch {
                // Preserve the deterministic timeout result even if reporting
                // the timeout fails.
              }
              resolve({ approved: false, error: `timed out after ${request.timeoutMs}ms` });
            }, request.timeoutMs)
          : null;
      this.pending.set(requestId, {
        resolve,
        timer,
        abortCleanup,
        userId: request.userId,
        clientId: request.clientId,
      });
      increment("tool_waits.started");
      setGauge("tool_waits.active", this.pending.size);
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      if (!this.pending.has(requestId)) return;
      try {
        request.emit(requestId);
      } catch {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.remove(requestId, pending);
        increment("tool_waits.cancelled");
        resolve({ approved: false, error: "tool request could not be delivered" });
      }
    });
    return { requestId, promise };
  }

  resolve(requestId: string, responder: { userId: string; clientId: string }, result: FrontendToolWaitResult): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.userId !== responder.userId || pending.clientId !== responder.clientId) return false;
    this.remove(requestId, pending);
    increment("tool_waits.completed");
    pending.resolve(result);
    return true;
  }

  cancelAll(reason = "tool request cancelled"): void {
    for (const [requestId, pending] of this.pending) {
      this.remove(requestId, pending);
      increment("tool_waits.cancelled");
      pending.resolve({ approved: false, error: reason });
    }
  }

  private remove(requestId: string, pending: PendingEntry): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.abortCleanup?.();
    pending.abortCleanup = null;
    this.pending.delete(requestId);
    setGauge("tool_waits.active", this.pending.size);
  }
}
