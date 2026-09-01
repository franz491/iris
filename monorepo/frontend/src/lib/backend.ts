// lib/backend.ts — backend URL resolution.
//
// The frontend normally talks to the backend same-origin (/api via the Vite
// dev proxy or a reverse proxy in production). To run backend and frontend
// on separate machines, an absolute backend origin can be configured:
//   1. compile-time default: VITE_IRIS_BACKEND_URL (e.g. "http://192.168.1.10:3000")
//   2. runtime override: settings modal, persisted in localStorage
//      ("iris.backendUrl") — takes precedence; applied on page reload.
import { createAuthClient } from "better-auth/client";
import { resolveRequestBase } from "./backend-url";
export { resolveRequestBase } from "./backend-url";

const LS_KEY = "iris.backendUrl";

/** Desktop/browser frontend is connect-only: it never owns or starts a backend. */
export const backendOwnership = "connect-only" as const;

function normalize(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) return `http://${u}`;
  return u;
}

/** Compile-time default from the environment (empty = same-origin). */
export const envBackendUrl: string = normalize((import.meta.env.VITE_IRIS_BACKEND_URL as string | undefined) ?? "");

/** Current base origin of the backend; "" means same-origin. */
let current: string = normalize(localStorage.getItem(LS_KEY) ?? "") || envBackendUrl;

/** Keep loopback development traffic same-origin so auth cookies are not split
 * between localhost and 127.0.0.1. Vite proxies /api to the backend. */
function requestBase(): string {
  return resolveRequestBase(current, location.protocol, location.hostname);
}

export function backendBase(): string {
  return requestBase();
}

export function backendIsDefault(): boolean {
  return current === envBackendUrl;
}

/** Validate a configured origin before persisting it at startup/reload. */
export function validateBackendUrl(url: string): string | null {
  const normalized = normalize(url);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "must use http or https";
    if (!parsed.hostname || parsed.pathname !== "/" || parsed.search || parsed.hash)
      return "must be an origin without a path";
    return null;
  } catch {
    return "must be an origin like http://host:3000";
  }
}

/**
 * Persist a new backend origin ("" resets to same-origin/env default).
 * Takes effect after a page reload (SSE connections and the auth client
 * bind to the URL at startup).
 */
export function setBackendBase(url: string): void {
  current = normalize(url);
  if (current === envBackendUrl || current === location.origin) localStorage.removeItem(LS_KEY);
  else localStorage.setItem(LS_KEY, current);
}

/** Resolve an API path ("/api/...") against the configured backend. */
export function apiUrl(path: string): string {
  return `${requestBase()}${path}`;
}

export const authClient = createAuthClient({
  baseURL: `${requestBase() || window.location.origin}/api/auth`,
});
