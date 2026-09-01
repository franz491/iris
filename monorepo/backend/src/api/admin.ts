import { Hono, type Context } from "hono";
import { readinessState } from "./health.js";
import { metricsSnapshot } from "../misc/metrics.js";
import { createSupportBundle } from "../misc/support-bundle.js";
import { stream } from "hono/streaming";
import { requireAdmin, requireRecentAuth } from "./auth-guards.js";
import {
  getAdminConfig,
  getChecklist,
  setChecklistState,
  listAudit,
  stagePatch,
  validatePatch,
  testPatch,
  applyPatch,
  getPatch,
  rollback,
  approvePatch,
  resetAdminConfig,
  auditUserMutation,
} from "../admin/store.js";
import {
  ensureService,
  listOwnedServices,
  probeService,
  serviceDefaults,
  stopOwnedService,
} from "../admin/services.js";
import { discover } from "../admin/discovery.js";
import { listModels, registerModel, removeModel } from "../admin/models.js";
import {
  bootstrapAvailable,
  claimBootstrapToken,
  completeBootstrapToken,
  releaseBootstrapToken,
} from "../admin/bootstrap.js";
import {
  canRemoveAdmin,
  listAdminUsers,
  listUserSessions,
  revokeUserSessions,
  setAdminRole,
  validateCredential,
} from "./auth.js";
import { setupListSections, setupReadSection, setupGetOptions, setupProposePatch } from "../admin/setup-tools.js";
import { resolvePrompt, dataFilePath, listPromptKeys } from "../prompts/library.js";
import { deletePrompt, setPrompt } from "../prompts/prompts.js";
import {
  deleteWorkflow,
  getHistory,
  getOutput,
  getQueue,
  getSystemStats,
  listWorkflows,
  saveWorkflow,
  submitWorkflow,
} from "../admin/comfyui.js";
import { transcribeAudio } from "../admin/stt.js";
import { readSetupSettings } from "../setup/settings.js";
import { readRuntimeConfig } from "../config/runtime.js";
import { deleteApiKey, listApiKeyNames, setApiKey } from "../model-router/keys.js";
import { createChat } from "../chat/chat.js";
import { auth, getUserName } from "./auth.js";
import {
  installAudioCpp,
  installComfyUi,
  installLlamaCpp,
  softwareStatus,
  resolveAudioRevision,
  resolveComfyUiRevision,
  type AudioBuildBackend,
} from "../admin/software.js";
import { audioFamilyMetadata } from "../admin/audio-metadata.js";
import {
  jsonBodyAbortedResponse,
  jsonBodyTimeoutResponse,
  jsonTooLargeResponse,
  probeJsonBody,
} from "./json-limits.js";
import { readBoundedBody } from "./binary-limits.js";
import { credentialKeys, credentialRateLimitResponse, tryCredentialAdmission } from "./credential-admission.js";
import { toAppError } from "../misc/error.js";
import { z } from "zod";
import { adminConfig } from "../admin/schema.js";
import { serviceProbeRateLimitResponse, serviceProbeLimiter } from "./service-probe-limiter.js";
import { uploadSource } from "./upload-limiter.js";
import { readRuntimeLimits } from "../config/runtime-limits.js";
import {
  configOperationKeys,
  configOperationRateLimitResponse,
  tryConfigOperationAdmission,
} from "./config-operation-admission.js";
import { mutationOriginDecision } from "./origin-policy.js";
export const adminApi = new Hono();
const bootstrapSchema = z
  .object({
    token: z.string().min(1).max(512),
    name: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(1024),
  })
  .strict();
const createUserSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    email: z.string().email().max(320),
    password: z.string().min(1).max(1024),
    role: z.enum(["user", "admin"]).optional(),
  })
  .strict();
const roleSchema = z.object({ role: z.enum(["user", "admin"]) }).strict();
const passwordSchema = z.object({ password: z.string().min(1).max(1024) }).strict();
const promptSchema = z.object({ value: z.string().trim().min(1).max(readRuntimeLimits().promptBytes) }).strict();
const checklistSchema = z
  .object({ state: z.enum(["not configured", "configured but untested", "verified", "explicitly skipped"]) })
  .strict();
const apiKeySchema = z.object({ value: z.string().min(1).max(4096) }).strict();
const backendSchema = z.object({ backend: z.enum(["cpu", "cuda", "vulkan", "hip", "metal"]) }).strict();
const audioInstallSchema = backendSchema.extend({ revision: z.string().regex(/^[0-9a-f]{40}$/i) }).strict();
const comfyInstallSchema = z.object({ revision: z.string().regex(/^[0-9a-f]{40}$/i) }).strict();
const setupProposalSchema = adminConfig.strict();
const modelRegistrationSchema = z
  .object({
    name: z.string().trim().min(1).max(256),
    path: z.string().min(1).max(4096),
    ownership: z.enum(["external", "managed"]).optional(),
  })
  .strict();
const comfyNodeSchema = z
  .object({
    class_type: z.string().min(1).max(256),
    inputs: z.record(z.string(), z.unknown()),
  })
  .strict();
const comfyWorkflowSchema = z
  .record(z.string().min(1).max(128), comfyNodeSchema)
  .refine((workflow) => Object.keys(workflow).length <= 10_000, "workflow has too many nodes");
const comfyIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
  .refine((value) => !/[\\/]/.test(value), "identifier must not contain path separators");
const workflowMutationSchema = z
  .object({
    name: comfyIdentifierSchema,
    workflow: comfyWorkflowSchema,
  })
  .strict();
const comfyPromptSchema = z
  .object({
    workflow: comfyWorkflowSchema,
    clientId: z.string().min(1).max(256).optional(),
  })
  .strict();
const patchApprovalSchema = z.object({ kind: z.enum(["standard", "network", "download"]) }).strict();
const audioMetadataQuerySchema = z.object({ family: z.string().trim().min(1).max(128).optional() }).strict();

function parseAudioMetadataQuery(
  request: Request,
): z.SafeParseReturnType<unknown, z.infer<typeof audioMetadataQuerySchema>> {
  const params = new URL(request.url).searchParams;
  const entries = [...params.entries()];
  const families = params.getAll("family");
  if (entries.some(([key]) => key !== "family") || families.length > 1) {
    return { success: false, error: new z.ZodError([]) };
  }
  return audioMetadataQuerySchema.safeParse(families.length === 1 ? { family: families[0] } : {});
}
const comfyOutputQuerySchema = z
  .object({
    filename: z.string().min(1).max(512),
    subfolder: z.string().max(512).default(""),
    type: z.enum(["output", "input", "temp"]).default("output"),
  })
  .strict();

function parseComfyOutputQuery(
  request: Request,
): z.SafeParseReturnType<unknown, z.infer<typeof comfyOutputQuerySchema>> {
  const params = new URL(request.url).searchParams;
  const entries = [...params.entries()];
  const values = new Map<string, string[]>();
  for (const [key, value] of entries) values.set(key, [...(values.get(key) ?? []), value]);
  if (entries.some(([key]) => !["filename", "subfolder", "type"].includes(key))) {
    return { success: false, error: new z.ZodError([]) };
  }
  for (const key of ["filename", "subfolder", "type"]) {
    if ((values.get(key)?.length ?? 0) > 1) return { success: false, error: new z.ZodError([]) };
  }
  return comfyOutputQuerySchema.safeParse({
    filename: values.get("filename")?.[0],
    subfolder: values.get("subfolder")?.[0],
    type: values.get("type")?.[0],
  });
}
const sttFilenameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const adminIdentifierSchema = comfyIdentifierSchema;
const parseAdminIdentifier = (value: string) => adminIdentifierSchema.safeParse(value);
const setupSectionSchema = z.enum(["server", "services", "profiles", "secrets", "tools", "prompts", "cache"]);

function parseSttFilename(request: Request): z.SafeParseReturnType<unknown, string> {
  const value = request.headers.get("x-filename");
  return sttFilenameSchema.safeParse(value === null ? "audio.wav" : value);
}

async function parseAdminBody<T extends z.ZodTypeAny>(
  c: { req: { json: () => Promise<unknown> } },
  schema: T,
): Promise<z.infer<T>> {
  const result = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!result.success) throw new Error("invalid request body");
  return result.data;
}
const trustedAdminOrigins = () => [...readRuntimeConfig().trustedOrigins];
const adminConfigured = () => listAdminUsers().some((user) => user.role === "admin");

/**
 * Mutations that can change credentials, executable software, services, or
 * durable runtime configuration require a fresh step-up authentication. Keep
 * this an explicit path policy so adding a low-risk endpoint does not silently
 * broaden the recent-auth requirement (or make bootstrap impossible).
 */
export function requiresRecentAuthPath(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) return false;
  if (path === "/reauth") return false;
  return (
    /^\/users\/[^/]+(?:\/(?:role|password|sessions))?$/.test(path) ||
    /^\/keys\/[^/]+$/.test(path) ||
    /^\/software\/(?:audio\.cpp|llama\.cpp|comfyui)\/install$/.test(path) ||
    (path === "/models" && normalizedMethod === "POST") ||
    (/^\/models\/[^/]+$/.test(path) && normalizedMethod === "DELETE") ||
    /^\/services\/[^/]+\/(?:start|stop)$/.test(path) ||
    /^\/patches\/[^/]+\/(?:approve|apply|rollback)$/.test(path) ||
    path === "/reset-defaults"
  );
}

adminApi.use("*", async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  const isBootstrapPath = c.req.path.startsWith("/bootstrap/") || c.req.path.startsWith("/api/admin/bootstrap/");
  if (!adminConfigured() && isBootstrapPath) return next();
  const origin = c.req.header("origin");
  const originDecision = mutationOriginDecision(origin, Boolean(c.req.header("cookie")), trustedAdminOrigins());
  if (originDecision !== "allowed") return c.json({ error: originDecision }, 403);
  // A browser can omit Origin on some cross-site form navigations. A
  // session-cookie mutation without it is therefore not safe to accept.
  // Authenticate mutations before entering handlers. Many legacy handlers
  // intentionally normalize their own operational errors, which otherwise
  // turns an authorization failure into a misleading 400 response.
  try {
    await requireAdmin(c.req.raw);
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
  if (requiresRecentAuthPath(c.req.method, c.req.path)) {
    try {
      await requireRecentAuth(c.req.raw);
    } catch {
      return c.json({ error: "recent_auth_required" }, 403);
    }
  }
  return next();
});
adminApi.use("*", async (c, next) => {
  const result = await probeJsonBody(c.req.raw, { signal: c.req.raw.signal });
  if (result === "too_large") return jsonTooLargeResponse();
  if (result === "timeout") return jsonBodyTimeoutResponse();
  if (result === "aborted") return jsonBodyAbortedResponse();
  return next();
});
adminApi.get("/bootstrap/status", (c) => c.json({ configured: adminConfigured(), available: bootstrapAvailable() }));
const reauthSchema = z.object({ password: z.string().min(1).max(1024) }).strict();
adminApi.post("/reauth", async (c) => {
  try {
    const current = await requireAdmin(c.req.raw);
    const body = await parseAdminBody(c, reauthSchema);
    const releaseAdmission = tryCredentialAdmission(credentialKeys(c.req.raw, current.userId));
    if (!releaseAdmission) return credentialRateLimitResponse();
    try {
      const result = await auth.api.verifyPassword({ headers: c.req.raw.headers, body: { password: body.password } });
      if (!result.status) return c.json({ error: "invalid_password" }, 401);
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session?.session?.id) return c.json({ error: "forbidden" }, 403);
      const authModule = await import("./auth.js");
      authModule.grantRecentAuth(session.session.id, current.userId);
      return c.json({ ok: true });
    } finally {
      releaseAdmission();
    }
  } catch {
    return c.json({ error: "invalid_password" }, 401);
  }
});
adminApi.post("/bootstrap/issue", (c) =>
  c.json(
    {
      error: "terminal_only",
      message:
        "Bootstrap tokens are printed only in the backend terminal. Restart the unconfigured backend to issue a new one.",
    },
    410,
  ),
);
adminApi.post("/bootstrap/consume", (c) =>
  c.json({ error: "use_create_admin", message: "The token is consumed atomically by create-admin." }, 410),
);
adminApi.post("/bootstrap/create-admin", async (c) => {
  const bodyResult = bootstrapSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!bodyResult.success) return c.json({ error: "token_name_password_required" }, 400);
  const body = bodyResult.data;
  const username = body.name.trim().toLowerCase();
  if (!/^[a-z0-9._-]{1,64}$/.test(username))
    return c.json(
      { error: "invalid_username", message: "Use 1-64 letters, numbers, dots, underscores, or hyphens." },
      400,
    );
  const email = `${username}@iris.local`;
  try {
    validateCredential(body.password, false);
  } catch {
    return c.json({ error: "password_policy_failed" }, 400);
  }
  const releaseAdmission = tryCredentialAdmission(credentialKeys(c.req.raw));
  if (!releaseAdmission) return credentialRateLimitResponse();
  if (!claimBootstrapToken(body.token)) {
    releaseAdmission();
    return c.json({ error: "invalid_or_expired_token" }, 401);
  }
  try {
    const authModule = await import("./auth.js");
    const result = await authModule.auth.api.signUpEmail({ body: { name: username, email, password: body.password } });
    const userId = result.user?.id;
    if (!userId || !authModule.setAdminRole(userId, "admin")) throw new Error("admin promotion failed");
    completeBootstrapToken(body.token);
    return c.json({ ok: true, userId, email }, 201);
  } catch {
    releaseBootstrapToken(body.token);
    return c.json({ error: "admin_creation_failed" }, 400);
  } finally {
    releaseAdmission();
  }
});
adminApi.get("/users", async (c) => {
  try {
    await actor(c);
    return c.json({ users: listAdminUsers().map((u) => ({ ...u, banned: Boolean(u.banned) })) });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.post("/users", async (c) => {
  try {
    const actorId = await actor(c);
    const body = await parseAdminBody(c, createUserSchema);
    validateCredential(body.password, false);
    const releaseAdmission = tryCredentialAdmission(credentialKeys(c.req.raw, actorId));
    if (!releaseAdmission) return credentialRateLimitResponse();
    try {
      const result = await (
        await import("./auth.js")
      ).auth.api.createUser({
        headers: c.req.raw.headers,
        body: { name: body.name, email: body.email, password: body.password, role: body.role ?? "user" },
      });
      return c.json(result, 201);
    } finally {
      releaseAdmission();
    }
  } catch (e) {
    const error = toAppError(e);
    return c.json(
      { error: error.code === "unauthorized" ? "forbidden" : "user_creation_failed" },
      error.code === "unauthorized" ? 403 : 400,
    );
  }
});
adminApi.post("/users/:id/role", async (c) => {
  try {
    const actorId = await actor(c);
    const targetId = c.req.param("id");
    const target = parseAdminIdentifier(targetId);
    if (!target.success) return c.json({ error: "validation_error", message: "invalid user id" }, 400);
    const body = await parseAdminBody(c, roleSchema);
    if (target.data === actorId && body.role !== "admin") return c.json({ error: "cannot_remove_own_admin_role" }, 409);
    if (body.role === "user" && !canRemoveAdmin(target.data)) return c.json({ error: "cannot_remove_last_admin" }, 409);
    const updated = setAdminRole(target.data, body.role);
    if (updated) {
      revokeUserSessions(target.data);
      auditUserMutation(actorId, target.data, "role_changed");
    }
    return c.json({ updated });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.post("/users/:id/password", async (c) => {
  try {
    const actorId = await actor(c);
    const target = parseAdminIdentifier(c.req.param("id"));
    if (!target.success) return c.json({ error: "validation_error", message: "invalid user id" }, 400);
    const releaseAdmission = tryCredentialAdmission(credentialKeys(c.req.raw, actorId));
    if (!releaseAdmission) return credentialRateLimitResponse();
    try {
      const targetId = target.data;
      const body = await parseAdminBody(c, passwordSchema);
      validateCredential(body.password, false);
      await (
        await import("./auth.js")
      ).auth.api.setUserPassword({
        headers: c.req.raw.headers,
        body: { userId: targetId, newPassword: body.password },
      });
      revokeUserSessions(targetId);
      auditUserMutation(actorId, targetId, "password_reset");
      return c.json({ ok: true });
    } finally {
      releaseAdmission();
    }
  } catch (e) {
    const error = toAppError(e);
    return c.json(
      { error: error.code === "unauthorized" ? "forbidden" : "password_reset_failed" },
      error.code === "unauthorized" ? 403 : 400,
    );
  }
});
adminApi.delete("/users/:id", async (c) => {
  try {
    const id = await actor(c);
    const target = c.req.param("id");
    const parsedTarget = parseAdminIdentifier(target);
    if (!parsedTarget.success) return c.json({ error: "validation_error", message: "invalid user id" }, 400);
    if (id === parsedTarget.data) return c.json({ error: "cannot_delete_self" }, 409);
    if (!canRemoveAdmin(parsedTarget.data)) return c.json({ error: "cannot_delete_last_admin" }, 409);
    if (c.req.header("x-iris-confirm") !== `delete-user:${parsedTarget.data}`)
      return c.json({ error: "explicit_confirmation_required" }, 409);
    await (
      await import("./auth.js")
    ).auth.api.removeUser({ headers: c.req.raw.headers, body: { userId: parsedTarget.data } });
    revokeUserSessions(parsedTarget.data);
    auditUserMutation(id, parsedTarget.data, "user_deleted");
    return c.json({ ok: true });
  } catch {
    return c.json({ error: "user_delete_failed" }, 400);
  }
});
adminApi.get("/users/:id/sessions", async (c) => {
  try {
    await actor(c);
    const target = parseAdminIdentifier(c.req.param("id"));
    if (!target.success) return c.json({ error: "validation_error", message: "invalid user id" }, 400);
    return c.json({ sessions: listUserSessions(target.data) });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.delete("/users/:id/sessions", async (c) => {
  try {
    const id = await actor(c);
    const target = c.req.param("id");
    const parsedTarget = parseAdminIdentifier(target);
    if (!parsedTarget.success) return c.json({ error: "validation_error", message: "invalid user id" }, 400);
    const revoked = revokeUserSessions(parsedTarget.data);
    auditUserMutation(id, parsedTarget.data, "sessions_revoked");
    return c.json({ revoked });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
async function actor(c: { req: { raw: Request } }): Promise<string> {
  return (await requireAdmin(c.req.raw)).userId;
}
adminApi.get("/status", async (c) => {
  try {
    const id = await actor(c);
    return c.json({
      ok: true,
      actorId: id,
      ...getAdminConfig(),
      defaultModel: readSetupSettings().defaultModel,
      checklist: getChecklist(),
    });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.get("/prompts", async (c) => {
  try {
    await actor(c);
    return c.json({ prompts: listPromptKeys() });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.get("/setup/sections", async (c) => {
  try {
    await actor(c);
    return c.json({ sections: setupListSections() });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.post("/setup/chat", async (c) => {
  try {
    const id = await actor(c);
    const setup = readSetupSettings();
    const checklist = getChecklist();
    const prompt = `You are Iris's guided setup assistant. Work through the schema-owned checklist and ask concise questions one section at a time. Use only the setup tools; they redact secrets. Never ask the user to paste a secret into chat. You may stage, validate, and test a complete proposal, but you cannot approve or apply it: tell the administrator to review the diff in /admin. Current checklist:\n${checklist.map((x) => `- ${x.group}: ${x.state}`).join("\n")}`;
    const chat = await createChat(
      [
        { role: "user", name: getUserName(id) ?? "administrator", userId: id },
        {
          role: "ai",
          name: "Iris Setup",
          model: setup.defaultModel.model,
          apiRouter: setup.defaultModel.apiRouter,
          maxContext: setup.defaultModel.maxContext,
          apiKeyName: setup.defaultModel.apiKeyName,
          prompt,
        },
      ],
      { loadedTools: ["admin_setup"] },
      "Iris guided setup",
    );
    return c.json({ chatId: chat.id }, 201);
  } catch (e) {
    return c.json({ error: "setup_chat_failed", message: String(e) }, 400);
  }
});
adminApi.get("/setup/sections/:section", async (c) => {
  try {
    await actor(c);
    const section = setupSectionSchema.safeParse(c.req.param("section"));
    if (!section.success) return c.json({ error: "validation_error", message: "invalid setup section" }, 400);
    return c.json({ section: section.data, value: setupReadSection(section.data) });
  } catch (e) {
    return c.json({ error: "invalid_section", message: String(e) }, 400);
  }
});
adminApi.get("/setup/options/:section", async (c) => {
  try {
    await actor(c);
    const section = setupSectionSchema.safeParse(c.req.param("section"));
    if (!section.success) return c.json({ error: "validation_error", message: "invalid setup section" }, 400);
    return c.json(setupGetOptions(section.data));
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.get("/prompts/:key", async (c) => {
  try {
    await actor(c);
    const key = c.req.param("key").replace(/__colon__/g, ":");
    const promptKey = parseAdminIdentifier(key);
    if (!promptKey.success) return c.json({ error: "validation_error", message: "invalid prompt key" }, 400);
    const value = await resolvePrompt(promptKey.data);
    return c.json({
      key: promptKey.data,
      value,
      origin: value ? "effective" : "missing",
      filePath: dataFilePath(promptKey.data),
    });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.put("/prompts/:key", async (c) => {
  try {
    const id = await actor(c);
    const key = c.req.param("key").replace(/__colon__/g, ":");
    const promptKey = parseAdminIdentifier(key);
    if (!promptKey.success) return c.json({ error: "validation_error", message: "invalid prompt key" }, 400);
    const body = await parseAdminBody(c, promptSchema);
    await setPrompt(promptKey.data, body.value);
    return c.json({ key: promptKey.data, value: await resolvePrompt(promptKey.data), origin: "database", actorId: id });
  } catch (e) {
    return c.json({ error: "prompt_update_failed", message: String(e) }, 400);
  }
});
adminApi.delete("/prompts/:key", async (c) => {
  try {
    await actor(c);
    const key = c.req.param("key").replace(/__colon__/g, ":");
    const promptKey = parseAdminIdentifier(key);
    if (!promptKey.success) return c.json({ error: "validation_error", message: "invalid prompt key" }, 400);
    await deletePrompt(promptKey.data);
    return c.json({ key: promptKey.data, value: await resolvePrompt(promptKey.data), origin: "default_or_file" });
  } catch (e) {
    return c.json({ error: "prompt_restore_failed", message: String(e) }, 400);
  }
});
adminApi.post("/setup/proposals", async (c) => {
  try {
    const id = await actor(c);
    const body = await parseAdminBody(c, setupProposalSchema);
    return c.json(setupProposePatch(id, body), 201);
  } catch (e) {
    return c.json({ error: "invalid_proposal", message: String(e) }, 400);
  }
});
adminApi.post("/checklist/:id", async (c) => {
  try {
    await actor(c);
    const checklistId = parseAdminIdentifier(c.req.param("id"));
    if (!checklistId.success) return c.json({ error: "validation_error", message: "invalid checklist id" }, 400);
    const body = await parseAdminBody(c, checklistSchema);
    return c.json(setChecklistState(checklistId.data, body.state));
  } catch (e) {
    return c.json({ error: "invalid_checklist", message: String(e) }, 400);
  }
});
adminApi.get("/audit", async (c) => {
  try {
    await actor(c);
    return c.json({ entries: listAudit() });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.get("/support-bundle", async (c) => {
  try {
    await actor(c);
    await requireRecentAuth(c.req.raw);
    const config = getAdminConfig().config;
    const body = createSupportBundle({
      version: "1",
      readiness: readinessState(),
      metrics: metricsSnapshot(),
      configSummary: {
        schemaVersion: config.schemaVersion,
        serviceCount: config.services.length,
        profileCount: config.profiles.length,
      },
      audit: listAudit(),
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="iris-support-bundle.json"',
      },
    });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.get("/keys", async (c) => {
  try {
    await actor(c);
    return c.json({ keys: listApiKeyNames() });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.put("/keys/:name", async (c) => {
  try {
    await actor(c);
    const name = parseAdminIdentifier(c.req.param("name"));
    if (!name.success) return c.json({ error: "validation_error", message: "invalid API key name" }, 400);
    const body = await parseAdminBody(c, apiKeySchema);
    setApiKey(name.data, body.value);
    return c.json({ ok: true, name: name.data });
  } catch (e) {
    return c.json({ error: "key_update_failed", message: String(e) }, 400);
  }
});
adminApi.delete("/keys/:name", async (c) => {
  try {
    await actor(c);
    const name = parseAdminIdentifier(c.req.param("name"));
    if (!name.success) return c.json({ error: "validation_error", message: "invalid API key name" }, 400);
    return c.json({ deleted: deleteApiKey(name.data) });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.get("/services/defaults", async (c) => {
  try {
    await actor(c);
    return c.json({ defaults: serviceDefaults() });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.get("/software", async (c) => {
  try {
    await actor(c);
    return c.json(softwareStatus());
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.get("/software/audio.cpp/revision", async (c) => {
  try {
    await actor(c);
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
  try {
    return c.json({
      revision: await resolveAudioRevision(),
      source: "https://github.com/0xShug0/audio.cpp",
      ref: "main",
    });
  } catch (e) {
    return c.json({ error: "revision_resolution_failed", message: String(e) }, 502);
  }
});
adminApi.get("/software/comfyui/revision", async (c) => {
  try {
    await actor(c);
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
  try {
    return c.json({
      revision: await resolveComfyUiRevision(),
      source: "https://github.com/comfyanonymous/ComfyUI",
      ref: "main",
    });
  } catch (e) {
    return c.json({ error: "revision_resolution_failed", message: String(e) }, 502);
  }
});
adminApi.get("/audio/metadata", async (c) => {
  try {
    await actor(c);
    const query = parseAudioMetadataQuery(c.req.raw);
    if (!query.success) return c.json({ error: "validation_error", message: "invalid audio metadata query" }, 400);
    return c.json(audioFamilyMetadata(query.data.family));
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
function installStream(
  c: Context,
  operation: (log: (text: string) => void, signal?: AbortSignal) => Promise<unknown>,
  releaseAdmission: () => void,
) {
  c.header("content-type", "application/x-ndjson; charset=utf-8");
  c.header("cache-control", "no-store");
  return stream(c, async (output) => {
    let writes: Promise<unknown> = Promise.resolve();
    const send = (event: unknown) => {
      writes = writes.then(() => output.write(JSON.stringify(event) + "\n"));
    };
    try {
      try {
        send({ type: "log", text: "Checking current requirements…\n" });
        const result = await operation((text) => send({ type: "log", text }), c.req.raw.signal);
        send({ type: "complete", result });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
      await writes;
    } finally {
      releaseAdmission();
    }
  });
}
adminApi.post("/software/audio.cpp/install", async (c) => {
  try {
    const actorId = await actor(c);
    const body = await parseAdminBody(c, audioInstallSchema);
    const release = tryCredentialAdmission(credentialKeys(c.req.raw, actorId));
    if (!release) return credentialRateLimitResponse();
    return installStream(
      c,
      (log, signal) => installAudioCpp(body.backend as AudioBuildBackend, log, { signal, revision: body.revision }),
      release,
    );
  } catch (e) {
    return c.json({ error: "install_failed", message: String(e) }, 400);
  }
});
adminApi.post("/software/llama.cpp/install", async (c) => {
  try {
    const actorId = await actor(c);
    const body = await parseAdminBody(c, backendSchema);
    const release = tryCredentialAdmission(credentialKeys(c.req.raw, actorId));
    if (!release) return credentialRateLimitResponse();
    return installStream(
      c,
      (log, signal) => installLlamaCpp(body.backend as AudioBuildBackend, log, { signal }),
      release,
    );
  } catch (e) {
    return c.json({ error: "install_failed", message: String(e) }, 400);
  }
});
adminApi.post("/software/comfyui/install", async (c) => {
  try {
    const actorId = await actor(c);
    const body = await parseAdminBody(c, comfyInstallSchema);
    const release = tryCredentialAdmission(credentialKeys(c.req.raw, actorId));
    if (!release) return credentialRateLimitResponse();
    return installStream(c, (log, signal) => installComfyUi(log, { signal, revision: body.revision }), release);
  } catch (e) {
    return c.json({ error: "install_failed", message: String(e) }, 400);
  }
});
adminApi.get("/services", async (c) => {
  try {
    const actorId = await actor(c);
    const source = uploadSource(c.req.raw);
    const retryAfter = serviceProbeLimiter.consume([`account:${actorId}`, ...(source ? [`source:${source}`] : [])]);
    if (retryAfter !== undefined) return serviceProbeRateLimitResponse(retryAfter);
    const cfg = getAdminConfig().config;
    return c.json({ services: await Promise.all(cfg.services.map(probeService)), owned: listOwnedServices() });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.get("/comfyui/workflows", async (c) => {
  try {
    await actor(c);
    return c.json({ workflows: listWorkflows() });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.put("/comfyui/workflows/:id", async (c) => {
  try {
    await actor(c);
    const id = comfyIdentifierSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "validation_error", message: "invalid workflow id" }, 400);
    const body = await parseAdminBody(c, workflowMutationSchema);
    return c.json(saveWorkflow(body.name, body.workflow, id.data));
  } catch (e) {
    return c.json({ error: "invalid_workflow", message: String(e) }, 400);
  }
});
adminApi.post("/comfyui/workflows", async (c) => {
  try {
    await actor(c);
    const body = await parseAdminBody(c, workflowMutationSchema);
    return c.json(saveWorkflow(body.name, body.workflow), 201);
  } catch (e) {
    return c.json({ error: "invalid_workflow", message: String(e) }, 400);
  }
});
adminApi.delete("/comfyui/workflows/:id", async (c) => {
  try {
    await actor(c);
    const id = comfyIdentifierSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "validation_error", message: "invalid workflow id" }, 400);
    return c.json({ deleted: deleteWorkflow(id.data) });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.post("/services/:name/comfyui/prompt", async (c) => {
  try {
    await actor(c);
    const name = comfyIdentifierSchema.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: "validation_error", message: "invalid ComfyUI service name" }, 400);
    const body = await parseAdminBody(c, comfyPromptSchema);
    const service = getAdminConfig().config.services.find((s) => s.name === name.data);
    if (!service || service.kind !== "comfyui") return c.json({ error: "comfyui_service_not_found" }, 404);
    return c.json(await submitWorkflow({ baseUrl: service.endpoint.baseUrl }, body.workflow, body.clientId));
  } catch (e) {
    return c.json({ error: "comfyui_request_failed", message: String(e) }, 400);
  }
});
adminApi.get("/services/:name/comfyui/history/:promptId", async (c) => {
  try {
    await actor(c);
    const name = comfyIdentifierSchema.safeParse(c.req.param("name"));
    const promptId = comfyIdentifierSchema.safeParse(c.req.param("promptId"));
    if (!name.success || !promptId.success)
      return c.json({ error: "validation_error", message: "invalid ComfyUI identifier" }, 400);
    const service = getAdminConfig().config.services.find((s) => s.name === name.data);
    if (!service || service.kind !== "comfyui") return c.json({ error: "comfyui_service_not_found" }, 404);
    return c.json(await getHistory({ baseUrl: service.endpoint.baseUrl }, promptId.data));
  } catch (e) {
    return c.json({ error: "comfyui_request_failed", message: String(e) }, 400);
  }
});
adminApi.get("/services/:name/comfyui/queue", async (c) => {
  try {
    await actor(c);
    const name = comfyIdentifierSchema.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: "validation_error", message: "invalid ComfyUI service name" }, 400);
    const service = getAdminConfig().config.services.find((s) => s.name === name.data);
    if (!service || service.kind !== "comfyui") return c.json({ error: "comfyui_service_not_found" }, 404);
    return c.json(await getQueue({ baseUrl: service.endpoint.baseUrl }));
  } catch (e) {
    return c.json({ error: "comfyui_request_failed", message: String(e) }, 400);
  }
});
adminApi.get("/services/:name/comfyui/stats", async (c) => {
  try {
    await actor(c);
    const name = comfyIdentifierSchema.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: "validation_error", message: "invalid ComfyUI service name" }, 400);
    const service = getAdminConfig().config.services.find((s) => s.name === name.data);
    if (!service || service.kind !== "comfyui") return c.json({ error: "comfyui_service_not_found" }, 404);
    return c.json(await getSystemStats({ baseUrl: service.endpoint.baseUrl }));
  } catch (e) {
    return c.json({ error: "comfyui_request_failed", message: String(e) }, 400);
  }
});
adminApi.get("/services/:name/comfyui/output", async (c) => {
  try {
    await actor(c);
    const name = comfyIdentifierSchema.safeParse(c.req.param("name"));
    if (!name.success) return c.json({ error: "validation_error", message: "invalid ComfyUI service name" }, 400);
    const query = parseComfyOutputQuery(c.req.raw);
    if (!query.success) return c.json({ error: "validation_error", message: "invalid ComfyUI output query" }, 400);
    const service = getAdminConfig().config.services.find((s) => s.name === name.data);
    if (!service || service.kind !== "comfyui") return c.json({ error: "comfyui_service_not_found" }, 404);
    const response = await getOutput(
      { baseUrl: service.endpoint.baseUrl },
      query.data.filename,
      query.data.subfolder,
      query.data.type,
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "application/octet-stream",
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    return c.json({ error: "comfyui_request_failed", message: String(e) }, 400);
  }
});
adminApi.post("/services/:name/stt/transcribe", async (c) => {
  try {
    await actor(c);
    const name = parseAdminIdentifier(c.req.param("name"));
    if (!name.success) return c.json({ error: "validation_error", message: "invalid service name" }, 400);
    const filename = parseSttFilename(c.req.raw);
    if (!filename.success) return c.json({ error: "validation_error", message: "invalid x-filename header" }, 400);
    const service = getAdminConfig().config.services.find((s) => s.name === name.data);
    if (!service || !["stt", "audio"].includes(service.kind)) return c.json({ error: "speech_service_not_found" }, 404);
    const body = await readBoundedBody(c.req.raw, readRuntimeLimits().sttBytes);
    const result = await transcribeAudio({ baseUrl: service.endpoint.baseUrl }, new Uint8Array(body), filename.data);
    return c.json(result);
  } catch (e) {
    const error = toAppError(e);
    return c.json({ error: error.code, message: error.message }, error.code === "payload_too_large" ? 413 : 400);
  }
});
adminApi.get("/discovery", async (c) => {
  try {
    await actor(c);
    return c.json(discover());
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.get("/models", async (c) => {
  try {
    await actor(c);
    return c.json({ models: listModels() });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.post("/models", async (c) => {
  try {
    await actor(c);
    const body = await parseAdminBody(c, modelRegistrationSchema);
    return c.json(registerModel(body), 201);
  } catch (e) {
    return c.json({ error: "invalid_model", message: String(e) }, 400);
  }
});
adminApi.delete("/models/:id", async (c) => {
  try {
    await actor(c);
    const modelId = parseAdminIdentifier(c.req.param("id"));
    if (!modelId.success) return c.json({ error: "validation_error", message: "invalid model id" }, 400);
    return c.json({ removed: removeModel(modelId.data) });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.post("/services/:name/start", async (c) => {
  try {
    const actorId = await actor(c);
    const name = parseAdminIdentifier(c.req.param("name"));
    if (!name.success) return c.json({ error: "validation_error", message: "invalid service name" }, 400);
    const service = getAdminConfig().config.services.find((s) => s.name === name.data);
    if (!service) return c.json({ error: "not_found" }, 404);
    const release = tryConfigOperationAdmission(configOperationKeys(c.req.raw, actorId));
    if (!release) return configOperationRateLimitResponse();
    try {
      const result = await ensureService(service);
      const process = result.process;
      return c.json({
        ...result,
        process: process
          ? {
              service: process.service,
              pid: process.pid,
              startedAt: process.startedAt,
              processStartIdentity: process.processStartIdentity,
            }
          : null,
      });
    } finally {
      release();
    }
  } catch (e) {
    return c.json({ error: "start_failed", message: String(e) }, 400);
  }
});
adminApi.post("/services/:name/stop", async (c) => {
  try {
    await actor(c);
    const name = parseAdminIdentifier(c.req.param("name"));
    if (!name.success) return c.json({ error: "validation_error", message: "invalid service name" }, 400);
    return c.json({ stopped: stopOwnedService(name.data) });
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
adminApi.post("/patches", async (c) => {
  try {
    const id = await actor(c);
    const body = await parseAdminBody(c, setupProposalSchema);
    return c.json(stagePatch(id, body), 201);
  } catch (e) {
    return c.json({ error: "invalid_patch", message: String(e) }, 400);
  }
});
adminApi.post("/patches/:id/validate", async (c) => {
  try {
    const id = await actor(c);
    const patchId = parseAdminIdentifier(c.req.param("id"));
    if (!patchId.success) return c.json({ error: "validation_error", message: "invalid patch id" }, 400);
    const release = tryConfigOperationAdmission(configOperationKeys(c.req.raw, id));
    if (!release) return configOperationRateLimitResponse();
    try {
      return c.json(validatePatch(patchId.data, id, false));
    } finally {
      release();
    }
  } catch (e) {
    return c.json({ error: "validation_failed", message: String(e) }, 400);
  }
});
adminApi.post("/patches/:id/test", async (c) => {
  try {
    const id = await actor(c);
    const patchId = parseAdminIdentifier(c.req.param("id"));
    if (!patchId.success) return c.json({ error: "validation_error", message: "invalid patch id" }, 400);
    const release = tryConfigOperationAdmission(configOperationKeys(c.req.raw, id));
    if (!release) return configOperationRateLimitResponse();
    try {
      return c.json(await testPatch(patchId.data, id, c.req.raw.signal));
    } finally {
      release();
    }
  } catch (e) {
    return c.json({ error: "test_failed", message: String(e) }, 400);
  }
});
adminApi.post("/patches/:id/approve", async (c) => {
  try {
    const id = await actor(c);
    const patchId = parseAdminIdentifier(c.req.param("id"));
    if (!patchId.success) return c.json({ error: "validation_error", message: "invalid patch id" }, 400);
    const body = await parseAdminBody(c, patchApprovalSchema);
    approvePatch(patchId.data, id, body.kind);
    return c.json({ ok: true, kind: body.kind });
  } catch (e) {
    return c.json({ error: "approval_failed", message: String(e) }, 400);
  }
});
adminApi.post("/patches/:id/apply", async (c) => {
  try {
    const id = await actor(c);
    const patchId = parseAdminIdentifier(c.req.param("id"));
    if (!patchId.success) return c.json({ error: "validation_error", message: "invalid patch id" }, 400);
    const release = tryConfigOperationAdmission(configOperationKeys(c.req.raw, id));
    if (!release) return configOperationRateLimitResponse();
    try {
      return c.json(await applyPatch(patchId.data, id));
    } finally {
      release();
    }
  } catch (e) {
    return c.json({ error: "apply_failed", message: String(e) }, 400);
  }
});
adminApi.post("/patches/:id/rollback", async (c) => {
  try {
    const id = await actor(c);
    const patchId = parseAdminIdentifier(c.req.param("id"));
    if (!patchId.success) return c.json({ error: "validation_error", message: "invalid patch id" }, 400);
    const release = tryConfigOperationAdmission(configOperationKeys(c.req.raw, id));
    if (!release) return configOperationRateLimitResponse();
    try {
      return c.json(await rollback(id, patchId.data));
    } finally {
      release();
    }
  } catch (e) {
    return c.json({ error: "rollback_failed", message: String(e) }, 400);
  }
});
adminApi.post("/reset-defaults", async (c) => {
  try {
    const id = await actor(c);
    return c.json({ config: resetAdminConfig(id) });
  } catch (e) {
    return c.json({ error: "reset_failed", message: String(e) }, 400);
  }
});
adminApi.get("/patches/:id", async (c) => {
  try {
    const id = await actor(c);
    const patchId = parseAdminIdentifier(c.req.param("id"));
    if (!patchId.success) return c.json({ error: "validation_error", message: "invalid patch id" }, 400);
    const p = getPatch(patchId.data);
    return p?.actorId === id ? c.json(p) : c.json({ error: "not_found" }, 404);
  } catch {
    return c.json({ error: "forbidden" }, 403);
  }
});
