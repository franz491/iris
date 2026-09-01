const counts = new Map<string, number>();
const durations = new Map<string, { total: number; count: number }>();
const gauges = new Map<string, number>();
const key = (method: string, status: number) => {
  const normalizedMethod = /^[A-Z]{1,16}$/.test(method.toUpperCase()) ? method.toUpperCase() : "OTHER";
  const normalizedStatus = Number.isFinite(status) ? Math.min(599, Math.max(100, Math.floor(status))) : 500;
  return `${normalizedMethod}.${Math.floor(normalizedStatus / 100)}xx`;
};
export function recordRequest(method: string, status: number, durationMs: number): void {
  const k = key(method, status);
  counts.set(k, (counts.get(k) ?? 0) + 1);
  const d = durations.get(k) ?? { total: 0, count: 0 };
  d.total += Number.isFinite(durationMs) ? Math.min(60_000, Math.max(0, durationMs)) : 0;
  d.count++;
  durations.set(k, d);
}
export function increment(name: string): void {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(name)) throw new Error("invalid metric name");
  counts.set(name, (counts.get(name) ?? 0) + 1);
}
export function recordDbOperation(durationMs: number, failed = false): void {
  const d = durations.get("db.operation") ?? { total: 0, count: 0 };
  d.total += Number.isFinite(durationMs) ? Math.min(60_000, Math.max(0, durationMs)) : 0;
  d.count++;
  durations.set("db.operation", d);
  if (failed) counts.set("db.failure", (counts.get("db.failure") ?? 0) + 1);
}
export function recordDuration(name: string, durationMs: number): void {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(name)) throw new Error("invalid metric name");
  const d = durations.get(name) ?? { total: 0, count: 0 };
  d.total += Number.isFinite(durationMs) ? Math.min(60_000, Math.max(0, durationMs)) : 0;
  d.count++;
  durations.set(name, d);
}
export function metricsSnapshot(): Record<string, unknown> {
  return {
    requests: Object.fromEntries([...counts].sort()),
    durationsMs: Object.fromEntries([...durations].sort()),
    gauges: Object.fromEntries([...gauges].sort()),
  };
}
export function setGauge(name: string, value: number): void {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(name)) throw new Error("invalid metric name");
  gauges.set(name, Math.max(0, Math.floor(value)));
}
export function resetMetrics(): void {
  counts.clear();
  durations.clear();
  gauges.clear();
}
