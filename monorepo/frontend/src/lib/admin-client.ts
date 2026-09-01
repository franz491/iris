import { apiUrl } from "./backend";

export type AdminStatus = {
  version: number;
  config: Record<string, unknown>;
  defaultModel?: { model?: string };
  checklist: Array<{ group: string; state: string }>;
};
export type AdminPatch = { id: string; status?: string; redactedDiff?: { _approvals?: { required?: string[] } } };
export type RecentAuthPrompt = () => Promise<boolean>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function parseAdminStatus(value: unknown): AdminStatus {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !isRecord(value.config) ||
    !Array.isArray(value.checklist) ||
    value.checklist.some(
      (item) => !isRecord(item) || typeof item.group !== "string" || typeof item.state !== "string",
    ) ||
    (value.defaultModel !== undefined &&
      (!isRecord(value.defaultModel) ||
        (value.defaultModel.model !== undefined && typeof value.defaultModel.model !== "string")))
  )
    throw new Error("Admin status response was invalid");
  return {
    version: value.version,
    config: value.config,
    defaultModel: value.defaultModel as AdminStatus["defaultModel"],
    checklist: value.checklist as AdminStatus["checklist"],
  };
}

export function parseAdminPatch(value: unknown): AdminPatch {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.status !== undefined && typeof value.status !== "string")
  )
    throw new Error("Admin patch response was invalid");
  if (value.redactedDiff !== undefined) {
    if (!isRecord(value.redactedDiff)) throw new Error("Admin patch response was invalid");
    const approvals = value.redactedDiff._approvals;
    if (
      approvals !== undefined &&
      (!isRecord(approvals) ||
        (approvals.required !== undefined &&
          (!Array.isArray(approvals.required) || approvals.required.some((item) => typeof item !== "string"))))
    )
      throw new Error("Admin patch response was invalid");
  }
  return value as AdminPatch;
}

export async function adminRequest<T = unknown>(
  path: string,
  init: RequestInit = {},
  prompt?: RecentAuthPrompt,
  parse?: (value: unknown) => T,
): Promise<T> {
  let retried = false;
  while (true) {
    const response = await fetch(`${apiUrl("/api")}/admin${path}`, {
      credentials: "include",
      ...init,
      headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
    });
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    if (response.ok) return parse ? parse(body) : (body as T);
    if (body && body.error === "recent_auth_required" && !retried && prompt && (await prompt())) {
      retried = true;
      continue;
    }
    const failure = new Error(body?.message ?? body?.error ?? `HTTP ${response.status}`);
    (failure as Error & { code?: string }).code = body?.error;
    throw failure;
  }
}

export const getAdminStatus = (prompt?: RecentAuthPrompt) => adminRequest("/status", {}, prompt, parseAdminStatus);
