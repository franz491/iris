import { apiUrl } from "./backend";

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  role?: string | null;
  banned?: boolean;
  createdAt?: number;
};
export class AdminRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
function fail(response: Response): never {
  throw new AdminRequestError(
    response.status === 401 || response.status === 403
      ? "administrator authorization required"
      : `admin users request failed (${response.status})`,
    undefined,
    response.status,
  );
}
function parseUsers(value: unknown): AdminUser[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { users?: unknown }).users))
    throw new Error("invalid admin users response");
  return (value as { users: unknown[] }).users.map((u) => {
    if (
      !u ||
      typeof u !== "object" ||
      typeof (u as any).id !== "string" ||
      typeof (u as any).name !== "string" ||
      typeof (u as any).email !== "string"
    )
      throw new Error("invalid admin user entry");
    return u as AdminUser;
  });
}
async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(apiUrl(`/api/admin${path}`), { credentials: "include", ...init });
  if (!response.ok) {
    if (response.status === 403) {
      const body = (await response
        .clone()
        .json()
        .catch(() => null)) as { error?: unknown } | null;
      if (body?.error === "recent_auth_required")
        throw new AdminRequestError("recent authentication required", "recent_auth_required", 403);
    }
    fail(response);
  }
  return response.json();
}
export async function listAdminUsers(signal?: AbortSignal): Promise<AdminUser[]> {
  return parseUsers(await request("/users", { signal }));
}
export async function deleteAdminUser(id: string, signal?: AbortSignal): Promise<void> {
  const value = await request(`/users/${encodeURIComponent(id)}`, {
    method: "DELETE",
    signal,
    headers: { "x-iris-confirm": `delete-user:${id}` },
  });
  if (!value || typeof value !== "object" || (value as { ok?: unknown }).ok !== true)
    throw new Error("invalid admin delete response");
}
export async function createAdminUser(
  input: { name: string; email: string; password: string; role?: string },
  signal?: AbortSignal,
): Promise<AdminUser> {
  const value = await request("/users", {
    method: "POST",
    signal,
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
  });
  if (!value || typeof value !== "object" || typeof (value as any).user?.id !== "string")
    throw new Error("invalid admin create response");
  return (value as any).user as AdminUser;
}
export async function changeAdminRole(id: string, role: string, signal?: AbortSignal): Promise<void> {
  await request(`/users/${encodeURIComponent(id)}/role`, {
    method: "POST",
    signal,
    body: JSON.stringify({ role }),
    headers: { "content-type": "application/json" },
  });
}
export async function resetAdminPassword(id: string, password: string, signal?: AbortSignal): Promise<void> {
  await request(`/users/${encodeURIComponent(id)}/password`, {
    method: "POST",
    signal,
    body: JSON.stringify({ password }),
    headers: { "content-type": "application/json" },
  });
}
export async function listAdminSessions(id: string, signal?: AbortSignal): Promise<unknown[]> {
  const value = await request(`/users/${encodeURIComponent(id)}/sessions`, { signal });
  if (!value || typeof value !== "object" || !Array.isArray((value as any).sessions))
    throw new Error("invalid admin sessions response");
  return (value as any).sessions;
}
export async function revokeAdminSessions(id: string, signal?: AbortSignal): Promise<number> {
  const value = await request(`/users/${encodeURIComponent(id)}/sessions`, { method: "DELETE", signal });
  if (!value || typeof value !== "object" || typeof (value as any).revoked !== "number")
    throw new Error("invalid admin revoke response");
  return (value as any).revoked;
}
