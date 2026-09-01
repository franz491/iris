// lib/toasts.ts — tiny global toast store.

export interface Toast {
  id: number;
  kind: "info" | "warn" | "error";
  message: string;
}

let nextId = 1;
export const toasts = $state<Toast[]>([]);

export function pushToast(kind: Toast["kind"], message: string, ttlMs = 6000): void {
  const id = nextId++;
  toasts.push({ id, kind, message });
  if (ttlMs > 0) {
    setTimeout(() => dismissToast(id), ttlMs);
  }
  // hard cap so failures can't flood the screen
  while (toasts.length > 6) toasts.shift();
}

export function dismissToast(id: number): void {
  const idx = toasts.findIndex((t) => t.id === id);
  if (idx >= 0) toasts.splice(idx, 1);
}

export function toastError(e: unknown): void {
  pushToast("error", e instanceof Error ? e.message : String(e));
}
