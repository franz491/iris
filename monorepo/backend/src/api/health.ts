import { Hono } from "hono";
import { metricsSnapshot } from "../misc/metrics.js";

export type ReadinessState = "starting" | "ready" | "failed" | "shutting_down";
let state: ReadinessState = "starting";

export function setReadiness(next: ReadinessState): void {
  state = next;
}
export function readinessState(): ReadinessState {
  return state;
}

export const health = new Hono();
health.get("/health", (c) => c.json({ status: "ok" }));
health.get("/ready", (c) =>
  c.json({ status: state === "ready" ? "ready" : "not_ready" }, state === "ready" ? 200 : 503),
);
health.get("/metrics", (c) => c.json(metricsSnapshot()));
