// api/auth.ts — verifies user sessions based on pin/password using BetterAuth.
// Every session is authed as one user or non-authed.
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import Database from "better-sqlite3";
import type { Database as Db2 } from "better-sqlite3";
import { dataFile } from "../db/sqlite.js";
import { ValidationError } from "../misc/error.js";
import { readRuntimeConfig } from "../config/runtime.js";
import { createHash } from "node:crypto";
import { credentialKeys, credentialRateLimitResponse, tryCredentialAdmission } from "./credential-admission.js";

const configuredTrustedOrigins = readRuntimeConfig().trustedOrigins;

export const PASSWORD_MIN_LENGTH = 12;
export const PIN_MIN_LENGTH = 4;

const SIGN_IN_SOURCE_FAILURE_LIMIT = 5;
const SIGN_IN_ACCOUNT_FAILURE_LIMIT = 20;
const SIGN_IN_FAILURE_WINDOW_MS = 60_000;
const SIGN_IN_FAILURE_MAX_KEYS = 10_000;
const SIGN_IN_PATH = "/sign-in/email";

type SignInFailure = { count: number; firstFailureAt: number };
export interface SignInLimiterStore {
  isBlocked(key: string, limit: number, now: number): boolean;
  retryAfter(keys: string[], now: number): number;
  recordFailure(key: string, now: number): void;
  clear(key: string): void;
  resetAll(): void;
}
export class InMemorySignInLimiterStore implements SignInLimiterStore {
  private readonly values = new Map<string, SignInFailure>();
  private purge(now: number) {
    for (const [key, value] of this.values)
      if (now - value.firstFailureAt >= SIGN_IN_FAILURE_WINDOW_MS) this.values.delete(key);
  }
  isBlocked(key: string, limit: number, now: number) {
    this.purge(now);
    return (this.values.get(key)?.count ?? 0) >= limit;
  }
  retryAfter(keys: string[], now: number) {
    this.purge(now);
    const values = keys.map((key) => this.values.get(key)).filter((v): v is SignInFailure => Boolean(v));
    return values.length
      ? Math.max(
          ...values.map((v) => Math.max(1, Math.ceil((SIGN_IN_FAILURE_WINDOW_MS - now + v.firstFailureAt) / 1000))),
        )
      : 60;
  }
  recordFailure(key: string, now: number) {
    this.purge(now);
    const value = this.values.get(key);
    if (!value) this.values.set(key, { count: 1, firstFailureAt: now });
    else value.count += 1;
    while (this.values.size > SIGN_IN_FAILURE_MAX_KEYS) this.values.delete(this.values.keys().next().value as string);
  }
  clear(key: string) {
    this.values.delete(key);
  }
  resetAll() {
    this.values.clear();
  }
}
export class SqliteSignInLimiterStore implements SignInLimiterStore {
  constructor(
    private readonly db: Db2,
    private readonly maxKeys = SIGN_IN_FAILURE_MAX_KEYS,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS sign_in_failures(key_hash TEXT PRIMARY KEY,count INTEGER NOT NULL,first_failure_at INTEGER NOT NULL); " +
        // Supports deterministic oldest-entry eviction without scanning hashes.
        "CREATE INDEX IF NOT EXISTS sign_in_failures_age ON sign_in_failures(first_failure_at)",
    );
  }
  private hash(key: string) {
    return createHash("sha256").update(key).digest("hex");
  }
  private purge(now: number) {
    this.db.prepare("DELETE FROM sign_in_failures WHERE first_failure_at <= ?").run(now - SIGN_IN_FAILURE_WINDOW_MS);
  }
  isBlocked(key: string, limit: number, now: number) {
    this.purge(now);
    const row = this.db.prepare("SELECT count FROM sign_in_failures WHERE key_hash=?").get(this.hash(key)) as
      { count: number } | undefined;
    return (row?.count ?? 0) >= limit;
  }
  retryAfter(keys: string[], now: number) {
    this.purge(now);
    const rows = keys
      .map(
        (key) =>
          this.db.prepare("SELECT first_failure_at FROM sign_in_failures WHERE key_hash=?").get(this.hash(key)) as
            { first_failure_at: number } | undefined,
      )
      .filter((r): r is { first_failure_at: number } => Boolean(r));
    return rows.length
      ? Math.max(
          ...rows.map((r) => Math.max(1, Math.ceil((SIGN_IN_FAILURE_WINDOW_MS - now + r.first_failure_at) / 1000))),
        )
      : 60;
  }
  recordFailure(key: string, now: number) {
    const tx = this.db.transaction(() => {
      this.purge(now);
      const hash = this.hash(key);
      this.db
        .prepare(
          "INSERT INTO sign_in_failures(key_hash,count,first_failure_at) VALUES(?,1,?) ON CONFLICT(key_hash) DO UPDATE SET count=count+1",
        )
        .run(hash, now);
      this.db
        .prepare(
          "DELETE FROM sign_in_failures WHERE rowid IN (SELECT rowid FROM sign_in_failures ORDER BY first_failure_at ASC, rowid ASC LIMIT MAX(0, (SELECT count(*) FROM sign_in_failures)-?))",
        )
        .run(this.maxKeys);
    });
    tx();
  }
  clear(key: string) {
    this.db.prepare("DELETE FROM sign_in_failures WHERE key_hash=?").run(this.hash(key));
  }
  resetAll() {
    this.db.exec("DELETE FROM sign_in_failures");
  }
}
let signInFailures: SignInLimiterStore = new InMemorySignInLimiterStore();

function signInKey(body: unknown): string | null {
  if (!body || typeof body !== "object" || !("email" in body)) return null;
  const email = (body as { email?: unknown }).email;
  return typeof email === "string" && email.length > 0 ? email.trim().toLowerCase() : null;
}

/** Only adapter-provided connection info is trusted; forwarded headers are client-controlled. */
function signInSource(request: Request): string | null {
  const address = request.headers.get("x-iris-remote-address");
  return address && address.length > 0 ? address : null;
}

function isSignInBlocked(key: string, now: number): boolean {
  const limit = key.startsWith("account:") ? SIGN_IN_ACCOUNT_FAILURE_LIMIT : SIGN_IN_SOURCE_FAILURE_LIMIT;
  return signInFailures.isBlocked(key, limit, now);
}

function signInRetryAfter(keys: string[], now: number): number {
  return signInFailures.retryAfter(keys, now);
}

function recordSignInFailure(key: string, now: number): void {
  signInFailures.recordFailure(key, now);
}

function clearSignInFailure(key: string): void {
  signInFailures.clear(key);
}

/** Clear process-local sign-in state; intended for test isolation and restarts. */
export function resetSignInFailureLimiter(): void {
  signInFailures.resetAll();
}

function signInRateLimitResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify({
      error: "too_many_sign_in_attempts",
      message: "Too many failed sign-in attempts; try again later.",
    }),
    {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(retryAfter), "cache-control": "no-store" },
    },
  );
}

/**
 * Credential policy: a PIN (numeric only) must be 4-6 digits; a password must
 * be at least PASSWORD_MIN_LENGTH chars. Both are stored by BetterAuth's
 * email+password credential flow (the "email" field acts as the username).
 */
export function validateCredential(credential: string, numericOnly: boolean): void {
  if (numericOnly) {
    if (!new RegExp(`^\\d{${PIN_MIN_LENGTH},6}$`).test(credential)) {
      throw new ValidationError("PIN must be 4-6 digits");
    }
    return;
  }
  if (credential.length < PASSWORD_MIN_LENGTH) {
    throw new ValidationError(`password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
}

const sqlite: Db2 = new Database(dataFile("auth.db"));
sqlite.pragma("journal_mode = WAL");

// BetterAuth does not auto-create its tables on a raw SQLite database;
// create them (matching its Kysely adapter expectations) before use.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    "emailVerified" INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    "createdAt" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,
    role TEXT,
    banned INTEGER,
    "banReason" TEXT,
    "banExpires" INTEGER
  );
  CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY,
    "expiresAt" INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    "createdAt" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    impersonatedBy TEXT
  );
  CREATE TABLE IF NOT EXISTS "account" (
    id TEXT PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    userId TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" INTEGER,
    "refreshTokenExpiresAt" INTEGER,
    scope TEXT,
    password TEXT,
    "createdAt" INTEGER NOT NULL,
    "updatedAt" INTEGER NOT NULL,
    issuer TEXT
  );
  CREATE TABLE IF NOT EXISTS "verification" (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    "expiresAt" INTEGER NOT NULL,
    "createdAt" INTEGER,
    "updatedAt" INTEGER
  );
`);
// Short-lived step-up authentication grants.  Only a one-way session/user
// binding is persisted; passwords and bearer tokens never enter this table.
sqlite.exec(`CREATE TABLE IF NOT EXISTS recent_auth_grants (
  binding_hash TEXT PRIMARY KEY, granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
); CREATE INDEX IF NOT EXISTS recent_auth_grants_expiry ON recent_auth_grants(expires_at);`);

const RECENT_AUTH_TTL_MS = 5 * 60 * 1000;
const recentAuthHash = (sessionId: string, userId: string) =>
  createHash("sha256").update(`${sessionId}:${userId}`).digest("hex");
function cleanupRecentAuth(now = Date.now()): void {
  sqlite.prepare("DELETE FROM recent_auth_grants WHERE expires_at <= ?").run(now);
}
export function grantRecentAuth(sessionId: string, userId: string, now = Date.now()): void {
  cleanupRecentAuth(now);
  sqlite
    .prepare("INSERT OR REPLACE INTO recent_auth_grants(binding_hash,granted_at,expires_at) VALUES(?,?,?)")
    .run(recentAuthHash(sessionId, userId), now, now + RECENT_AUTH_TTL_MS);
}
export function hasRecentAuthGrant(sessionId: string, userId: string, now = Date.now()): boolean {
  cleanupRecentAuth(now);
  return Boolean(
    sqlite
      .prepare("SELECT 1 FROM recent_auth_grants WHERE binding_hash=? AND expires_at > ?")
      .get(recentAuthHash(sessionId, userId), now),
  );
}

// Production instances share the initialized auth database; tests can still
// inject the in-memory implementation by replacing this binding in-process.
signInFailures = new SqliteSignInLimiterStore(sqlite);

// BetterAuth manages its own schema migrations on first use.
export const auth = betterAuth({
  database: sqlite,
  // public URL of THIS backend; override when hosted elsewhere
  baseURL: readRuntimeConfig().publicUrl,
  basePath: "/api/auth",
  // frontends allowed to call the auth endpoints (comma-separated env list)
  trustedOrigins: [...configuredTrustedOrigins],
  plugins: [admin()],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: PASSWORD_MIN_LENGTH,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
  },
});

const authHandler = auth.handler.bind(auth);
auth.handler = async (request) => {
  const url = new URL(request.url);
  if (request.method !== "POST" || !url.pathname.endsWith(SIGN_IN_PATH)) return authHandler(request);

  const body = await request
    .clone()
    .json()
    .catch(() => null);
  const account = signInKey(body);
  const source = signInSource(request);
  const keys = [account ? `account:${account}` : null, source ? `ip:${source}` : null].filter((key): key is string =>
    Boolean(key),
  );
  const now = Date.now();
  if (keys.some((key) => isSignInBlocked(key, now))) return signInRateLimitResponse(signInRetryAfter(keys, now));
  // A malformed/unknown sign-in is not a bootstrap operation; never let it
  // contend for the one-shot bootstrap admission key.
  const releaseAdmission = tryCredentialAdmission(credentialKeys(request, account ?? undefined, false));
  if (!releaseAdmission) return credentialRateLimitResponse();
  try {
    const response = await authHandler(request);
    if (response.status === 401) keys.forEach((key) => recordSignInFailure(key, Date.now()));
    else if (response.ok && account) clearSignInFailure(`account:${account}`);
    return response;
  } finally {
    releaseAdmission();
  }
};

export type Session = typeof auth.$Infer.Session;

/** Look up a user's pfp (profile image) from the auth DB. */
export function getUserImage(userId: string): string | null {
  const row = sqlite.prepare('SELECT image FROM "user" WHERE id = ?').get(userId) as
    { image: string | null } | undefined;
  return row?.image ?? null;
}

/** Look up a user's display name from the auth DB. */
export function getUserName(userId: string): string | null {
  const row = sqlite.prepare('SELECT name FROM "user" WHERE id = ?').get(userId) as { name: string | null } | undefined;
  return row?.name ?? null;
}

/** Resolve a username (stored as <name>@iris.local) to its user id + name + image. */
export function findUserByName(name: string): { id: string; name: string; image: string | null } | null {
  const row = sqlite.prepare('SELECT id, name, image FROM "user" WHERE email = ?').get(`${name}@iris.local`) as
    { id: string; name: string; image: string | null } | undefined;
  return row ?? null;
}

/** Canonical credential mutation used by administrative and recovery flows. */
export async function resetUserCredential(userId: string, credential: string, headers?: HeadersInit): Promise<number> {
  validateCredential(credential, /^\d{4,6}$/.test(credential));
  const account = sqlite
    .prepare('SELECT id,password FROM "account" WHERE userId=? AND providerId=?')
    .get(userId, "credential") as { id: string; password: string | null } | undefined;
  if (!account) throw new Error("no credential account found");
  const sessions = sqlite.prepare('SELECT * FROM "session" WHERE userId=?').all(userId) as Array<
    Record<string, unknown>
  >;
  const releaseAdmission = tryCredentialAdmission([`account:${userId}`]);
  if (!releaseAdmission) throw new Error("credential admission unavailable");
  try {
    const result = await auth.api.setUserPassword({ headers, body: { userId, newPassword: credential } });
    if (!result || (result as { status?: boolean }).status === false) throw new Error("credential reset failed");
    if (process.env.IRIS_TEST_RESET_FAULT === "after-hash") throw new Error("credential reset interrupted");
    return revokeUserSessions(userId);
  } catch (error) {
    // BetterAuth's public API owns hashing; compensate atomically if the
    // session phase fails, restoring the exact prior credential and sessions.
    sqlite.transaction(() => {
      sqlite.prepare('UPDATE "account" SET password=? WHERE id=?').run(account.password, account.id);
      sqlite.prepare('DELETE FROM "session" WHERE userId=?').run(userId);
      const insert = sqlite.prepare(
        'INSERT INTO "session" VALUES (@id,@expiresAt,@token,@createdAt,@updatedAt,@ipAddress,@userAgent,@userId,@impersonatedBy)',
      );
      for (const session of sessions) insert.run(session);
    })();
    throw error;
  } finally {
    releaseAdmission();
  }
}

export function findUsersByIdentifier(
  identifier: string,
): Array<{ id: string; name: string; email: string; role: string | null }> {
  const value = identifier.trim().toLowerCase();
  return sqlite
    .prepare('SELECT id,name,email,role FROM "user" WHERE lower(name)=? OR lower(email)=?')
    .all(value, value) as Array<{ id: string; name: string; email: string; role: string | null }>;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string | null;
  banned: boolean;
  createdAt: number;
}
export function listAdminUsers(): AdminUser[] {
  return sqlite.prepare('SELECT id,name,email,role,banned,createdAt FROM "user" ORDER BY name').all() as AdminUser[];
}
export function adminCount(): number {
  return (sqlite.prepare('SELECT COUNT(*) AS count FROM "user" WHERE role = ?').get("admin") as { count: number })
    .count;
}

/** A final administrator may not be demoted or deleted. */
export function canRemoveAdmin(userId: string): boolean {
  return !isAdminUser(userId) || adminCount() > 1;
}

export function setAdminRole(userId: string, role: "admin" | "user"): boolean {
  return sqlite.transaction(() => {
    if (role === "user" && !canRemoveAdmin(userId)) return false;
    return sqlite.prepare('UPDATE "user" SET role=? WHERE id=?').run(role, userId).changes > 0;
  })();
}
export function isAdminUser(userId: string): boolean {
  return Boolean(
    (sqlite.prepare('SELECT role FROM "user" WHERE id=?').get(userId) as { role?: string } | undefined)?.role ===
    "admin",
  );
}
export function revokeUserSessions(userId: string): number {
  return (sqlite.prepare('DELETE FROM "session" WHERE userId=?').run(userId) as { changes: number }).changes;
}
export function listUserSessions(
  userId: string,
): Array<{ id: string; expiresAt: number; createdAt: number; ipAddress: string | null; userAgent: string | null }> {
  return sqlite
    .prepare('SELECT id,expiresAt,createdAt,ipAddress,userAgent FROM "session" WHERE userId=? ORDER BY createdAt DESC')
    .all(userId) as Array<{
    id: string;
    expiresAt: number;
    createdAt: number;
    ipAddress: string | null;
    userAgent: string | null;
  }>;
}
