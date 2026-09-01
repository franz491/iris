// lib/backend-probe.ts — backend reachability probe (injectable fetch for tests).

/**
 * Returns true only when the backend answered OK. A proxy responding
 * 502/504 (backend down behind Vite/Tauri dev server) counts as OFFLINE —
 * fetch itself resolves in that case, so status must be checked.
 */
export async function probeBackend(fetchImpl: typeof fetch, url = "/api/models", timeoutMs = 4000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
