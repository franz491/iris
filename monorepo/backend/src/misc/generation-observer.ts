import { randomUUID } from "node:crypto";
import { increment, setGauge } from "./metrics.js";
export type GenerationEvent = {
  event: "started" | "completed" | "failed" | "cancelled";
  generationId: string;
  timestamp: string;
};
let active = 0;
export interface GenerationObserverDeps {
  id?: () => string;
  now?: () => string;
  isCancelled?: () => boolean;
}
export function observeGeneration(
  run: () => Promise<void>,
  sink: (event: GenerationEvent) => void = () => undefined,
  deps: GenerationObserverDeps = {},
): Promise<void> {
  const generationId = (deps.id ?? randomUUID)();
  const emit = (event: GenerationEvent["event"]) => {
    try {
      sink({ event, generationId, timestamp: (deps.now ?? (() => new Date().toISOString()))() });
    } catch {
      // Observability must never prevent generation execution or cleanup.
    }
  };
  active++;
  setGauge("generations.active", active);
  increment("generations.started");
  emit("started");
  let execution: Promise<void>;
  try {
    execution = Promise.resolve(run());
  } catch (error) {
    execution = Promise.reject(error);
  }
  return execution
    .then(
      () => {
        if (deps.isCancelled?.()) {
          increment("generations.cancelled");
          emit("cancelled");
        } else {
          increment("generations.completed");
          emit("completed");
        }
      },
      (error) => {
        increment("generations.failed");
        emit("failed");
        throw error;
      },
    )
    .finally(() => {
      active--;
      setGauge("generations.active", active);
    });
}
