import { randomUUID } from "node:crypto";
import { dataFile, openDb } from "../db/sqlite.js";
import { readBoundedResponse } from "../api/binary-limits.js";
import { readRuntimeLimits } from "../config/runtime-limits.js";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface ComfyWorkflow {
  [nodeId: string]: { class_type: string; inputs: Record<string, unknown> };
}

export const db = openDb(dataFile("admin.db")).sqlite;
export function migrateComfyWorkflowsDb(injectFailure = false, connection = db): void {
  connection.transaction(() => {
    connection.exec(
      "CREATE TABLE IF NOT EXISTS admin_comfy_workflows(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,workflow TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admin_comfy_workflows_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
    );
    if (injectFailure) throw new Error("injected workflow migration failure");
    connection.prepare("INSERT OR IGNORE INTO admin_comfy_workflows_schema_migrations VALUES(1, ?)").run(Date.now());
  })();
}
migrateComfyWorkflowsDb();

export interface StoredWorkflow {
  id: string;
  name: string;
  workflow: ComfyWorkflow;
  createdAt: string;
  updatedAt: string;
}

type WorkflowRow = {
  id: string;
  name: string;
  workflow: string;
  created_at: string;
  updated_at: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const workflowRow = (value: unknown): WorkflowRow => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.workflow !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string"
  ) {
    throw new Error("malformed ComfyUI workflow row");
  }
  return value as WorkflowRow;
};

const createdAtRow = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.created_at !== "string") throw new Error("malformed ComfyUI workflow row");
  return value.created_at;
};

export function listWorkflows(): StoredWorkflow[] {
  return db
    .prepare("SELECT * FROM admin_comfy_workflows ORDER BY name")
    .all()
    .map((value) => {
      const row = workflowRow(value);
      let workflow: unknown;
      try {
        workflow = JSON.parse(row.workflow);
      } catch {
        throw new Error("malformed ComfyUI workflow row");
      }
      validateWorkflow(workflow);
      return { id: row.id, name: row.name, workflow, createdAt: row.created_at, updatedAt: row.updated_at };
    });
}

export function saveWorkflow(name: string, workflow: ComfyWorkflow, id: string = randomUUID()): StoredWorkflow {
  if (!name.trim() || !workflow || typeof workflow !== "object")
    throw new Error("workflow name and graph are required");
  const now = new Date().toISOString();
  const createdAt = createdAtRow(db.prepare("SELECT created_at FROM admin_comfy_workflows WHERE id=?").get(id)) ?? now;
  db.prepare(
    "INSERT INTO admin_comfy_workflows VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,workflow=excluded.workflow,updated_at=excluded.updated_at",
  ).run(id, name.trim(), JSON.stringify(workflow), createdAt, now);
  return { id, name: name.trim(), workflow, createdAt, updatedAt: now };
}

export function deleteWorkflow(id: string): boolean {
  return db.prepare("DELETE FROM admin_comfy_workflows WHERE id=?").run(id).changes > 0;
}

export interface ComfyClient {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
type ComfyLookup = (hostname: string) => Promise<ResolvedAddress[]>;
const defaultComfyLookup: ComfyLookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map((item) => ({ address: item.address, family: item.family as 4 | 6 }));
let comfyLookup: ComfyLookup = defaultComfyLookup;
export function setComfyLookupForTests(resolver?: ComfyLookup): void {
  comfyLookup = resolver ?? defaultComfyLookup;
}

const isBlockedAddress = (value: string): boolean => {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedAddress(mapped[1]);
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) return address === "::" || /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(address);
  return true;
};

const validateComfyUrl = async (raw: URL): Promise<ResolvedAddress> => {
  if (!["http:", "https:"].includes(raw.protocol)) throw new Error("ComfyUI URL must use http or https");
  if (raw.username || raw.password) throw new Error("ComfyUI URL must not contain credentials");
  if (raw.hash) throw new Error("ComfyUI URL must not contain a fragment");
  const hostname = raw.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname) && hostname !== "127.0.0.1" && hostname !== "::1")
      throw new Error("ComfyUI URL targets a disallowed address");
    return { address: hostname, family: isIP(hostname) as 4 | 6 };
  }
  if (raw.hostname.toLowerCase() === "localhost") return { address: "127.0.0.1", family: 4 };
  const addresses = await comfyLookup(raw.hostname);
  if (!addresses.length || addresses.some((item) => isBlockedAddress(item.address)))
    throw new Error("ComfyUI URL resolves to a disallowed address");
  const selected = addresses[0];
  if (selected.address === "::1" || selected.address.startsWith("127."))
    throw new Error("ComfyUI hostname may not resolve to loopback unless it is localhost");
  return selected;
};
const validateComfyUrlSyntax = (raw: URL): void => {
  if (!["http:", "https:"].includes(raw.protocol)) throw new Error("ComfyUI URL must use http or https");
  if (raw.username || raw.password) throw new Error("ComfyUI URL must not contain credentials");
  if (raw.hash) throw new Error("ComfyUI URL must not contain a fragment");
};

export type ComfyRequest = (
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
  body?: string,
  maxBytes?: number,
) => Promise<Response>;
const pinnedRequest: ComfyRequest = async (
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
  body?: string,
  maxBytes = readRuntimeLimits().attachmentBytes,
): Promise<Response> =>
  await new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        servername: url.hostname,
        method: body === undefined ? "GET" : "POST",
        headers: {
          host: url.host,
          ...(body === undefined
            ? {}
            : { "content-type": "application/json", "content-length": Buffer.byteLength(body).toString() }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const advertised = Number(response.headers["content-length"]);
        if (Number.isFinite(advertised) && advertised > maxBytes) {
          request.destroy(new Error("ComfyUI response body exceeds maximum size"));
          return;
        }
        response.on("data", (chunk) => {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += part.length;
          if (size > maxBytes) {
            request.destroy(new Error("ComfyUI response body exceeds maximum size"));
            return;
          }
          chunks.push(part);
        });
        response.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 0,
              headers: response.headers as Record<string, string>,
            }),
          ),
        );
        response.on("error", reject);
      },
    );
    const abort = () =>
      request.destroy(signal.reason instanceof Error ? signal.reason : new Error("ComfyUI request aborted"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request.on("error", reject);
    request.on("close", () => signal.removeEventListener("abort", abort));
    request.end(body);
  });
let comfyRequest: ComfyRequest = pinnedRequest;
export function setComfyRequestForTests(request?: ComfyRequest): void {
  comfyRequest = request ?? pinnedRequest;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_QUERY_VALUE_LENGTH = 512;

type JsonRecord = Record<string, unknown>;

const validateJsonValue = (value: unknown, depth = 0): void => {
  const limits = readRuntimeLimits();
  if (depth > limits.comfyJsonDepth) throw new Error("ComfyUI response exceeded maximum JSON depth");
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw new Error("ComfyUI response contained an invalid number");
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > limits.comfyJsonStringBytes)
      throw new Error("ComfyUI response contained an oversized string");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > limits.comfyJsonKeys) throw new Error("ComfyUI response contained too many array items");
    for (const item of value) validateJsonValue(item, depth + 1);
    return;
  }
  if (!isRecord(value)) throw new Error("ComfyUI response contained an unsupported value");
  const keys = Object.keys(value);
  if (keys.length > limits.comfyJsonKeys) throw new Error("ComfyUI response contained too many object keys");
  for (const key of keys) {
    if (Buffer.byteLength(key, "utf8") > MAX_QUERY_VALUE_LENGTH)
      throw new Error("ComfyUI response contained an oversized key");
    validateJsonValue(value[key], depth + 1);
  }
};

const validateIdentifier = (value: string, field: string): string => {
  if (!value || value.length > MAX_QUERY_VALUE_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`ComfyUI ${field} is invalid`);
  }
  return value;
};

const validateWorkflow: (workflow: unknown) => asserts workflow is ComfyWorkflow = (workflow: unknown): void => {
  if (!isRecord(workflow)) throw new Error("ComfyUI workflow must be an object");
  if (Object.keys(workflow).length > readRuntimeLimits().comfyJsonKeys)
    throw new Error("ComfyUI workflow contains too many nodes");
  for (const [nodeId, node] of Object.entries(workflow)) {
    validateIdentifier(nodeId, "node id");
    if (!isRecord(node) || typeof node.class_type !== "string" || !node.class_type.trim() || !isRecord(node.inputs)) {
      throw new Error("ComfyUI workflow contains an invalid node");
    }
    validateIdentifier(node.class_type, "class type");
    validateJsonValue(node.inputs);
  }
};

const validatePathQuery = (value: string, field: "filename" | "subfolder", allowEmpty: boolean): string => {
  if (!allowEmpty && !value) throw new Error(`ComfyUI ${field} is required`);
  if (value.length > MAX_QUERY_VALUE_LENGTH) throw new Error(`ComfyUI ${field} is too long`);
  if (value.includes("\\") || value.startsWith("/") || value.startsWith("~") || value.split("/").includes("..")) {
    throw new Error(`unsafe ComfyUI ${field}`);
  }
  for (const character of value) {
    if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f) throw new Error(`unsafe ComfyUI ${field}`);
  }
  return value;
};

const readJson = async (response: Response): Promise<unknown> => {
  const bytes = await readBoundedResponse(response, readRuntimeLimits().jsonBodyBytes);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("ComfyUI response was not valid JSON");
  }
  validateJsonValue(value);
  return value;
};

const withTimeout = async <T>(c: ComfyClient, operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
    throw new Error("ComfyUI timeout is invalid");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("ComfyUI request timed out")), timeoutMs);
  const callerSignal = c.signal;
  const abortCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortCaller();
  else callerSignal?.addEventListener("abort", abortCaller, { once: true });
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortCaller);
  }
};

const call = async (c: ComfyClient, path: string, shape: string): Promise<JsonRecord> => {
  const f = c.fetchImpl ?? fetch;
  const response = await withTimeout(c, async (signal) => {
    const url = new URL(path, c.baseUrl);
    if (c.fetchImpl) {
      validateComfyUrlSyntax(url);
      return f(url, { signal });
    }
    const address = await validateComfyUrl(url);
    return comfyRequest(url, address, signal, undefined, readRuntimeLimits().jsonBodyBytes);
  });
  if (!response.ok) throw new Error(`ComfyUI ${response.status}`);
  const body = await readJson(response);
  if (!isRecord(body)) throw new Error(`ComfyUI ${shape} response must be an object`);
  return body;
};

export async function submitWorkflow(
  c: ComfyClient,
  workflow: ComfyWorkflow,
  clientId?: string,
): Promise<{ promptId: string }> {
  validateWorkflow(workflow);
  if (clientId !== undefined) validateIdentifier(clientId, "client id");
  const requestBody = JSON.stringify({ prompt: workflow, ...(clientId ? { client_id: clientId } : {}) });
  const jsonBodyBytes = readRuntimeLimits().jsonBodyBytes;
  if (Buffer.byteLength(requestBody, "utf8") > jsonBodyBytes)
    throw new Error(`ComfyUI request body exceeds ${jsonBodyBytes} bytes`);
  const f = c.fetchImpl ?? fetch;
  const response = await withTimeout(c, async (signal) => {
    const url = new URL("/prompt", c.baseUrl);
    if (!c.fetchImpl)
      return comfyRequest(url, await validateComfyUrl(url), signal, requestBody, readRuntimeLimits().jsonBodyBytes);
    validateComfyUrlSyntax(url);
    return f(url, { method: "POST", headers: { "content-type": "application/json" }, signal, body: requestBody });
  });
  if (!response.ok) throw new Error(`ComfyUI ${response.status}`);
  const body = await readJson(response);
  if (!isRecord(body) || typeof body.prompt_id !== "string") throw new Error("ComfyUI response omitted prompt_id");
  validateIdentifier(body.prompt_id, "prompt id");
  return { promptId: body.prompt_id };
}

export async function getHistory(c: ComfyClient, promptId: string): Promise<unknown> {
  validateIdentifier(promptId, "prompt id");
  return call(c, `/history/${encodeURIComponent(promptId)}`, "history");
}
export async function getQueue(c: ComfyClient): Promise<unknown> {
  const body = await call(c, "/queue", "queue");
  if (!Array.isArray(body.queue_running) || !Array.isArray(body.queue_pending))
    throw new Error("ComfyUI queue response has an invalid shape");
  return body;
}
export function getSystemStats(c: ComfyClient): Promise<unknown> {
  return call(c, "/system_stats", "system stats");
}

export async function getOutput(c: ComfyClient, filename: string, subfolder = "", type = "output"): Promise<Response> {
  validatePathQuery(filename, "filename", false);
  validatePathQuery(subfolder, "subfolder", true);
  if (!["output", "input", "temp"].includes(type)) throw new Error("ComfyUI type is invalid");
  const f = c.fetchImpl ?? fetch;
  const response = await withTimeout(c, async (signal) => {
    const url = new URL(
      `/view?filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`,
      c.baseUrl,
    );
    if (c.fetchImpl) {
      validateComfyUrlSyntax(url);
      return f(url, { signal });
    }
    return comfyRequest(url, await validateComfyUrl(url), signal, undefined, readRuntimeLimits().attachmentBytes);
  });
  const bytes = await readBoundedResponse(response, readRuntimeLimits().attachmentBytes);
  return new Response(new Uint8Array(bytes), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
