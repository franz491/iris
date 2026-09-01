// index.ts — backend entrypoint.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { errorEvent, eventRecord, logger as makeLogger } from "./misc/logging.js";
import { registerInstalledProviders } from "./providers/installed/index.js";
import { kernel } from "./runtime/kernel.js";
import { migrateChatDb } from "./chat/database.js";
import { migrateMemoryDb } from "./memory/sql.js";
import { migratePromptsDb } from "./prompts/prompts.js";
import { clearBuiltinPromptCache } from "./prompts/library.js";
import { api } from "./api/api.js";
import { auth } from "./api/auth.js";
import { getConnInfo } from "@hono/node-server/conninfo";
import { filesApi, reconcileAttachmentStaging } from "./api/files.js";
import { registerTrustedSource } from "./api/upload-limiter.js";
import { adminApi } from "./api/admin.js";
import { originMatches } from "./setup/settings.js";
import { readRuntimeConfig } from "./config/runtime.js";
import { createShutdownCoordinator, installSignalShutdown } from "./runtime/shutdown.js";
import { closeAllSse } from "./api/sse-owner.js";
import { closeAllDatabases } from "./db/sqlite.js";
import { recoverBeforeProjection } from "./runtime/reconcile-startup.js";
import { health, setReadiness } from "./api/health.js";
import { cancelAllPendingToolRequests } from "./chat/chat.js";
import { clearToolDocCache } from "./chat/tools.js";
import { DATA_DIR } from "./db/sqlite.js";
import { parseRecoveryRetentionPolicy, startRecoveryRetentionAfterReady } from "./db/recovery-retention-scheduler.js";
import path from "node:path";
import { acquireMaintenanceLock, type MaintenanceLock } from "./runtime/maintenance-lock.js";
import { createFetchHandler } from "./http-handler.js";

const log = makeLogger("main");

const app = new Hono();
app.route("/", health);
app.use("/api/*", async (c, next) => {
  registerTrustedSource(c.req.raw, getConnInfo(c).remote.address);
  return next();
});

async function startConfiguredServices(): Promise<void> {
  const [{ getAdminConfig }, { ensureService, probeService }] = await Promise.all([
    import("./admin/store.js"),
    import("./admin/services.js"),
  ]);
  await Promise.all(
    getAdminConfig().config.services.map(async (service) => {
      try {
        const probe = await probeService(service);
        if (probe.reachable) {
          log.info(JSON.stringify(eventRecord("services", "service.running")));
          return;
        }
        if (service.mode === "connect-only") {
          log.warn(JSON.stringify(eventRecord("services", "service.connect_only_unavailable", {}, "warn")));
          return;
        }
        log.info(JSON.stringify(eventRecord("services", "service.starting")));
        const result = await ensureService(service);
        if (result.readiness.reachable) log.info(JSON.stringify(eventRecord("services", "service.ready")));
        else
          log.error(
            JSON.stringify(
              errorEvent(
                "services",
                "service.not_ready",
                "service_not_ready",
                undefined,
                new Error("service readiness failed"),
              ),
            ),
          );
      } catch (error) {
        log.error(
          JSON.stringify(errorEvent("services", "service.start_failed", "service_start_failed", undefined, error)),
        );
      }
    }),
  );
}

// CORS: allow the frontend to live on a different machine than the backend.
// Allowed origins come from IRIS_TRUSTED_ORIGINS (comma-separated, same env
// BetterAuth uses); credentials are required because auth is cookie-based.
const allowedOrigins = readRuntimeConfig().trustedOrigins;
const dynamicCors = async (c: { req: { header(n: string): string | undefined } }, next: () => Promise<void>) => {
  const origin = c.req.header("origin");
  if (!origin || !originMatches(origin, [...allowedOrigins])) return next(); // same-origin or unknown: no CORS headers
  return cors({ origin, credentials: true })(c as never, next);
};
app.use("/api/*", dynamicCors);

app.route("/api", api);

// Auth gets its own router: mounting it inside the main app collides with a
// Hono 4.13 trie bug (a static route like GET /chats/guest makes the
// /auth/** wildcard unreachable). Serving it first avoids the shared trie.
const authApp = new Hono();
authApp.use("/api/auth/*", dynamicCors);
authApp.on(["POST", "GET"], "/api/auth/**", (c) => {
  // Inject adapter-provided peer address; auth deliberately ignores forwarded headers.
  const address = getConnInfo(c).remote.address;
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-iris-remote-address");
  if (address) headers.set("x-iris-remote-address", address);
  return auth.handler(new Request(c.req.raw, { headers }));
});
// Files use the same adapter-only peer identity as auth for abuse controls.
// Strip any client-supplied value before entering the sub-application.
app.use("/api/files/*", async (c) => {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("x-iris-remote-address");
  const address = getConnInfo(c).remote.address;
  if (address) headers.set("x-iris-remote-address", address);
  const request = new Request(c.req.raw, { headers });
  registerTrustedSource(request, address);
  return filesApi.fetch(request, c.env, c.executionCtx);
});
app.route("/api/admin", adminApi);

async function main(): Promise<void> {
  setReadiness("starting");
  let runtimeLock: MaintenanceLock | undefined;
  try {
    runtimeLock = acquireMaintenanceLock(DATA_DIR, "runtime");
    migrateChatDb();
    migrateMemoryDb();
    migratePromptsDb();
    registerInstalledProviders();
    await reconcileAttachmentStaging();

    const { listAdminUsers } = await import("./api/auth.js");
    if (!listAdminUsers().some((user) => user.role === "admin")) {
      const { issueBootstrapToken } = await import("./admin/bootstrap.js");
      const token = issueBootstrapToken(60 * 60);
      log.warn("Iris is not configured. Open /admin and enter this one-use bootstrap token:");
      log.warn(token);
      log.warn("The token expires in 1 hour. Use an SSH tunnel or HTTPS when bootstrapping across a network.");
    }

    // Core capabilities: memory is always available to AIs; file read/write is
    // always available internally for chat attachments. Tool-group settings
    // still decide whether an AI can call backend_files.
    const { getConfig, setConfig } = await import("./runtime/config-parser.js");
    const cfgs = await getConfig();
    if (!cfgs["memory"]) {
      await setConfig("memory", {
        name: "memory",
        activeFunctionalities: ["list_keywords", "list_memories", "add_memory", "remove_memory"],
        additionalSettings: {},
      });
    }
    if (!cfgs["admin-setup"]) {
      await setConfig("admin-setup", {
        name: "admin-setup",
        activeFunctionalities: [
          "list_sections",
          "read_section",
          "get_options",
          "propose_patch",
          "validate_patch",
          "test_patch",
        ],
        additionalSettings: {
          aiAllowedFunctionalities: [
            "list_sections",
            "read_section",
            "get_options",
            "propose_patch",
            "validate_patch",
            "test_patch",
          ],
        },
      });
    }
    const filesCfg = cfgs["files"];
    const requiredFileFunctions = ["create_file", "read_file"];
    if (!filesCfg) {
      await setConfig("files", {
        name: "files",
        activeFunctionalities: requiredFileFunctions,
        additionalSettings: { rootFolder: "files/" },
      });
    } else if (requiredFileFunctions.some((fn) => !filesCfg.activeFunctionalities.includes(fn))) {
      await setConfig("files", {
        ...filesCfg,
        activeFunctionalities: [...new Set([...filesCfg.activeFunctionalities, ...requiredFileFunctions])],
      });
    }

    const shellCfg = cfgs["shell"];
    if (shellCfg && shellCfg.additionalSettings.rootFolder === "shell/") {
      await setConfig("shell", {
        ...shellCfg,
        additionalSettings: {
          ...shellCfg.additionalSettings,
          rootFolder: String(filesCfg?.additionalSettings.rootFolder ?? "files/"),
        },
      });
    }

    // The admin plane is authoritative for AI-callable backend tools. Reconcile
    // already-applied settings on startup as well as during Apply, so upgrades
    // repair older installs whose admin and provider databases diverged.
    // Replay any interrupted configuration transaction before projecting the
    // authoritative admin state into live providers. A recovery failure aborts
    // startup, preventing a second reconciliation from masking the inconsistency.
    const { getAdminConfig, recoverReconciliationJournal } = await import("./admin/store.js");
    await recoverBeforeProjection(recoverReconciliationJournal, async () => {
      const appliedTools = getAdminConfig().config.tools;
      const currentProviders = await getConfig();
      const { providerFunctionalities } = await import("./chat/tools.js");
      for (const [name, tool] of Object.entries(appliedTools)) {
        const active = providerFunctionalities(name, tool.active);
        const allowed = providerFunctionalities(name, name === "files" ? tool.allowed : tool.active);
        await setConfig(name, {
          name,
          activeFunctionalities: active,
          additionalSettings: {
            ...(currentProviders[name]?.additionalSettings ?? {}),
            aiAllowedFunctionalities: allowed,
          },
        });
      }
    });
    await kernel.start();
    setReadiness("ready");
    const retentionPolicy = parseRecoveryRetentionPolicy(process.env);
    const retentionScheduler = startRecoveryRetentionAfterReady(
      true,
      { dataRoot: DATA_DIR, tempRoot: process.env.IRIS_RECOVERY_TEMP_ROOT ?? path.join(DATA_DIR, "recovery-tmp") },
      retentionPolicy,
      {
        onError: (_error) => {
          log.warn(
            JSON.stringify(eventRecord("recovery_retention", "retention.failed", { outcome: "contained" }, "warn")),
          );
        },
      },
    );

    const { port, hostname } = readRuntimeConfig();
    const fetchHandler = createFetchHandler(authApp, app);
    const server = serve({ fetch: fetchHandler, port, hostname }, () => {
      log.info(JSON.stringify(eventRecord("http", "server.listening")));
      void startConfiguredServices();
    });
    const coordinator = createShutdownCoordinator();
    coordinator.register(() => setReadiness("shutting_down"));
    // Register listener closure before dependent resource drains so no new
    // requests can race SSE, tool, service, or database shutdown.
    installSignalShutdown(coordinator, process, server)();
    coordinator.register(() => retentionScheduler?.stop());
    coordinator.register(clearToolDocCache);
    coordinator.register(clearBuiltinPromptCache);
    coordinator.register(() => cancelAllPendingToolRequests("process shutting down"));
    coordinator.register(closeAllSse);
    const { stopAllOwnedServices } = await import("./admin/services.js");
    coordinator.register(stopAllOwnedServices);
    coordinator.register(closeAllDatabases);
    coordinator.register(() => runtimeLock?.release());
  } catch (error) {
    runtimeLock?.release();
    setReadiness("failed");
    throw error;
  }
}

void main();
