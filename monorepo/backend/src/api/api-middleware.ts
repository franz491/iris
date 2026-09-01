import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { logger } from "../misc/logging.js";
import { recordRequest } from "../misc/metrics.js";
import {
  jsonBodyAbortedResponse,
  jsonBodyTimeoutResponse,
  jsonTooLargeResponse,
  probeJsonBody,
} from "./json-limits.js";

const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveRequestCorrelationId(value: string | undefined): string {
  return value && requestIdPattern.test(value) ? value : randomUUID();
}

export function accessLogRecord(requestId: string, method: string, url: string, status: number, started: number) {
  return {
    timestamp: new Date().toISOString(),
    level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
    component: "http",
    event: "request.completed",
    correlationId: requestId,
    requestId,
    method,
    path: new URL(url).pathname,
    status,
    durationMs: Math.max(0, Date.now() - started),
  };
}

export interface ApiMiddlewareDeps {
  accessLog?: Pick<ReturnType<typeof logger>, "info">;
  recordRequest?: (method: string, status: number, durationMs: number) => void;
  probeJsonBody?: typeof probeJsonBody;
  jsonTooLargeResponse?: () => Response;
  jsonBodyTimeoutResponse?: () => Response;
  jsonBodyAbortedResponse?: () => Response;
}

/** Install request correlation/access logging and bounded JSON probing. */
export function registerApiMiddleware(app: Hono, deps: ApiMiddlewareDeps = {}): void {
  const accessLog = deps.accessLog ?? logger("http");
  const record = deps.recordRequest ?? recordRequest;
  const probe = deps.probeJsonBody ?? probeJsonBody;
  const tooLarge = deps.jsonTooLargeResponse ?? jsonTooLargeResponse;
  const timedOut = deps.jsonBodyTimeoutResponse ?? jsonBodyTimeoutResponse;
  const aborted = deps.jsonBodyAbortedResponse ?? jsonBodyAbortedResponse;

  app.use("*", async (c, next) => {
    const started = Date.now();
    const supplied = c.req.header("x-correlation-id");
    const correlationId = resolveRequestCorrelationId(supplied);
    (c.set as (key: string, value: unknown) => void)("requestId", correlationId);
    await next();
    record(c.req.method, c.res.status, Date.now() - started);
    c.header("x-request-id", correlationId);
    accessLog.info(JSON.stringify(accessLogRecord(correlationId, c.req.method, c.req.url, c.res.status, started)));
  });

  app.use("*", async (c, next) => {
    const result = await probe(c.req.raw, { signal: c.req.raw.signal });
    if (result === "too_large") return tooLarge();
    if (result === "timeout") return timedOut();
    if (result === "aborted") return aborted();
    return next();
  });
}
