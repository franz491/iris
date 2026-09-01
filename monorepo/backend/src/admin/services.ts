import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { delimiter, isAbsolute, resolve } from "node:path";
import { cpus } from "node:os";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AdminConfig } from "./schema.js";
import { increment, setGauge } from "../misc/metrics.js";
import { dataFile } from "../db/sqlite.js";

interface AudioCppModel {
  id: string;
  family: string;
  path: string;
  task: string;
  mode: string;
  default_voice_preset?: {
    voice_ref?: string;
    reference_text?: string;
    speaker?: string;
  };
}
type ServiceCapabilities = { models: string[] } | { response: Record<string, unknown> };
export interface ServiceProbe {
  name: string;
  reachable: boolean;
  protocol: string;
  status: number | null;
  detail: string;
  capabilities?: ServiceCapabilities;
}
export interface OwnedProcess {
  service: string;
  pid: number;
  startedAt: number;
  processStartIdentity: string;
  processGroupId: number | null;
  child: ChildProcess;
  logs: string[];
  lockFile: string;
}
const owned = new Map<string, OwnedProcess>();

export function serviceDefaults(): Record<string, AdminConfig["services"][number]> {
  const llamaCommand = executablePath("llama")
    ? { executable: "llama", arguments: ["serve", "--host", "127.0.0.1", "--port", "8080"] }
    : { executable: "llama-server", arguments: ["--host", "127.0.0.1", "--port", "8080"] };
  const defaults: Record<string, AdminConfig["services"][number]> = {
    llm: {
      name: "llama.cpp",
      kind: "llm",
      mode: "connect-or-start",
      endpoint: {
        baseUrl: "http://127.0.0.1:8080/v1",
        healthCheck: { protocol: "openai-model-list" },
        startupTimeoutSeconds: 120,
      },
      process: { ...llamaCommand, workingDirectory: "", environment: {} },
      shutdownPolicy: "leave-running",
    },
    audio: {
      name: "audio.cpp",
      kind: "audio",
      mode: "connect-or-start",
      endpoint: { baseUrl: "http://127.0.0.1:8100", healthCheck: { protocol: "audio" }, startupTimeoutSeconds: 300 },
      process: {
        executable: "audiocpp_server",
        arguments: ["--config", audioCppConfigPath({ name: "audio.cpp" })],
        workingDirectory: "",
        environment: {},
      },
      audioCpp: {
        modelId: "pocket-tts",
        family: "pocket_tts",
        modelPath: "models/pocket-tts",
        task: "tts",
        mode: "offline",
        backend: "best",
        device: 0,
        threads: Math.max(1, Math.min(8, cpus().length)),
        lazyLoad: true,
        defaultVoicePreset: { speaker: "Serena" },
        asrModel: { modelId: "qwen3-asr", family: "qwen3_asr", modelPath: "models/Qwen3-ASR-0.6B", mode: "offline" },
      },
      shutdownPolicy: "leave-running",
    },
    comfyui: {
      name: "ComfyUI",
      kind: "comfyui",
      mode: "connect-or-start",
      endpoint: { baseUrl: "http://127.0.0.1:8188", healthCheck: { protocol: "comfyui" }, startupTimeoutSeconds: 300 },
      process: {
        executable: "python3",
        arguments: ["main.py", "--listen", "127.0.0.1", "--port", "8188"],
        workingDirectory: "",
        environment: {},
      },
      shutdownPolicy: "leave-running",
    },
  };
  writeAudioCppConfig(defaults.audio, audioCppConfigPath(defaults.audio));
  return defaults;
}

function audioCppConfigPath(service: Pick<AdminConfig["services"][number], "name">): string {
  return dataFile(`audio-cpp/${service.name.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}
function writeAudioCppConfig(service: AdminConfig["services"][number], path: string): void {
  if (!service.audioCpp) return;
  const a = service.audioCpp;
  mkdirSync(resolve(path, ".."), { recursive: true });
  const models: AudioCppModel[] = [
    {
      id: a.modelId,
      family: a.family,
      path: a.modelPath,
      task: a.task,
      mode: a.mode,
      ...(a.defaultVoicePreset
        ? {
            default_voice_preset: {
              ...(a.defaultVoicePreset.voiceRef ? { voice_ref: a.defaultVoicePreset.voiceRef } : {}),
              ...(a.defaultVoicePreset.referenceText ? { reference_text: a.defaultVoicePreset.referenceText } : {}),
              ...(a.defaultVoicePreset.speaker ? { speaker: a.defaultVoicePreset.speaker } : {}),
            },
          }
        : {}),
    },
  ];
  if (a.asrModel)
    models.push({
      id: a.asrModel.modelId,
      family: a.asrModel.family,
      path: a.asrModel.modelPath,
      task: "asr",
      mode: a.asrModel.mode,
    });
  writeFileSync(
    path,
    JSON.stringify(
      {
        host: "127.0.0.1",
        port: new URL(service.endpoint.baseUrl).port ? Number(new URL(service.endpoint.baseUrl).port) : 8100,
        backend: a.backend,
        device: a.device,
        threads: a.threads,
        lazy_load: a.lazyLoad,
        models,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}

function executablePath(executable: string, workingDirectory?: string): string | null {
  const candidates = executable.includes("/")
    ? [isAbsolute(executable) ? executable : resolve(workingDirectory || process.cwd(), executable)]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => resolve(dir, executable));
  for (const candidate of candidates)
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  return null;
}

function endpoint(baseUrl: string, path: string): URL {
  return new URL(`${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
}
function lockPath(name: string): string {
  return dataFile(`locks/service-${createHash("sha256").update(name).digest("hex").slice(0, 24)}.lock`);
}
function processIdentity(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const fields = stat.slice(end + 2).split(" ");
    return `${pid}:${fields[19]}`;
  } catch {
    return `${pid}:unavailable`;
  }
}
function processExists(pid: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function managedProcessEnvironment(configured: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const inheritedKeys = process.platform === "win32" ? ["PATH", "SystemRoot", "WINDIR", "ComSpec"] : ["PATH"];
  const inherited: NodeJS.ProcessEnv = {};
  for (const key of inheritedKeys) if (process.env[key] !== undefined) inherited[key] = process.env[key];
  return { ...inherited, ...configured };
}

const BLOCKED_SERVICE_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "instance-data.ec2.internal",
]);
type Address = { address: string; family: 4 | 6 };
type ServiceLookup = (hostname: string) => Promise<Address[]>;
type ServiceResponse = { status: number; body: Buffer };
const defaultServiceLookup: ServiceLookup = async (hostname) =>
  (await lookup(hostname, { all: true })).map((item) => ({ address: item.address, family: item.family as 4 | 6 }));
let serviceLookup: ServiceLookup = defaultServiceLookup;
export function setServiceLookupForTests(resolver?: ServiceLookup): void {
  serviceLookup = resolver ?? defaultServiceLookup;
}
type ServiceRequest = (url: URL, address: Address) => Promise<ServiceResponse>;

const MAX_SERVICE_MODELS = 4096;
const MAX_SERVICE_MODEL_ID_LENGTH = 1024;
const MAX_LOCK_RECORD_BYTES = 4096;
const MAX_LOCK_SERVICE_LENGTH = 256;
const MAX_PID = 2_147_483_647;

interface PersistedLockRecord {
  pid: number;
  service: string;
  createdAt: number;
}

function isValidPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_PID;
}

function parseLockRecord(raw: string, expectedService: string): PersistedLockRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      !isValidPid(record.pid) ||
      record.service !== expectedService ||
      expectedService.length === 0 ||
      expectedService.length > MAX_LOCK_SERVICE_LENGTH
    )
      return null;
    if (typeof record.createdAt !== "number" || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0)
      return null;
    return { pid: record.pid, service: expectedService, createdAt: record.createdAt };
  } catch {
    return null;
  }
}

function parseOpenAIModelList(body: unknown): string[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const data = (body as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length > MAX_SERVICE_MODELS) return null;
  const models: string[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_SERVICE_MODEL_ID_LENGTH) return null;
    models.push(id);
  }
  return models;
}

function isBlockedServiceHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_SERVICE_HOSTS.has(host)) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 169 && octets[1] === 254;
  }
  return isIP(host) === 6 && (host === "::" || host.startsWith("fe80:"));
}

function isDisallowedResolvedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isDisallowedResolvedAddress(mapped[1]);
  if (normalized === "::1" || /^127\./.test(normalized)) return false;
  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
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
  if (isIP(normalized) === 6) return normalized === "::" || /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(normalized);
  return true;
}

async function resolveValidatedEndpoint(url: URL): Promise<{ address: string; family: 4 | 6 } | string> {
  if (isIP(url.hostname))
    return isDisallowedResolvedAddress(url.hostname)
      ? "endpoint.baseUrl resolves to a disallowed private, link-local, or metadata address"
      : { address: url.hostname, family: isIP(url.hostname) as 4 | 6 };
  try {
    const addresses = await serviceLookup(url.hostname);
    if (!addresses.length || addresses.some((item) => isDisallowedResolvedAddress(item.address)))
      return "endpoint.baseUrl resolves to a disallowed private, link-local, or metadata address";
    const selected = addresses[0];
    if ((selected.address === "::1" || selected.address.startsWith("127.")) && url.hostname !== "localhost")
      return "endpoint.baseUrl hostname may not resolve to loopback unless it is localhost";
    return selected;
  } catch {
    return "endpoint.baseUrl hostname could not be resolved safely";
  }
}

async function defaultPinnedServiceRequest(url: URL, address: Address): Promise<ServiceResponse> {
  return await new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
        servername: url.hostname,
        headers: { host: url.host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let settled = false;
        response.on("data", (chunk) => {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += part.length;
          if (size > 2 * 1024 * 1024 && !settled) {
            settled = true;
            request.destroy(new Error("service probe response exceeded 2 MiB"));
            reject(new Error("service probe response exceeded 2 MiB"));
            return;
          }
          if (!settled) chunks.push(part);
        });
        response.on("end", () => {
          if (!settled) {
            settled = true;
            resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) });
          }
        });
        response.on("error", (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      },
    );
    request.setTimeout(5000, () => request.destroy(new Error("service probe timed out")));
    request.on("error", reject);
    request.end();
  });
}
let serviceRequest: ServiceRequest = defaultPinnedServiceRequest;
export function setServiceRequestForTests(request?: ServiceRequest): void {
  serviceRequest = request ?? defaultPinnedServiceRequest;
}

export function validateServiceDefinition(service: AdminConfig["services"][number]): string[] {
  const errors: string[] = [];
  try {
    const url = new URL(service.endpoint.baseUrl);
    if (!["http:", "https:"].includes(url.protocol)) errors.push("endpoint.baseUrl must use http or https");
    if (url.username || url.password) errors.push("endpoint.baseUrl must not contain credentials");
    if (url.hash) errors.push("endpoint.baseUrl must not contain a fragment");
    if (isBlockedServiceHost(url.hostname))
      errors.push("endpoint.baseUrl targets a blocked metadata or link-local host");
  } catch {
    errors.push("endpoint.baseUrl must be a URL");
  }
  if (service.mode !== "connect-only" && !service.process) errors.push("process is required for managed modes");
  if (service.audioCpp && !["audio", "tts"].includes(service.kind))
    errors.push("audioCpp settings are only valid for audio services");
  if (["audio", "tts"].includes(service.kind) && service.audioCpp?.task !== "tts")
    errors.push("audio.cpp speech services must include a TTS model");
  return errors;
}

export async function probeService(service: AdminConfig["services"][number]): Promise<ServiceProbe> {
  const errors = validateServiceDefinition(service);
  const protocol = service.endpoint.healthCheck.protocol;
  if (errors.length) return { name: service.name, reachable: false, protocol, status: null, detail: errors.join("; ") };
  const target =
    protocol === "openai-model-list"
      ? endpoint(service.endpoint.baseUrl, "models")
      : protocol === "comfyui"
        ? endpoint(service.endpoint.baseUrl, "system_stats")
        : ["audio", "tts", "stt"].includes(protocol)
          ? endpoint(service.endpoint.baseUrl, "health")
          : new URL(service.endpoint.baseUrl);
  try {
    const resolved = await resolveValidatedEndpoint(target);
    if (typeof resolved === "string")
      return { name: service.name, reachable: false, protocol, status: null, detail: resolved };
    const response = await serviceRequest(target, resolved);
    if (response.body.byteLength > 2 * 1024 * 1024)
      return {
        name: service.name,
        reachable: false,
        protocol,
        status: null,
        detail: "service probe response exceeded 2 MiB",
      };
    if (response.status < 200 || response.status >= 300)
      return {
        name: service.name,
        reachable: false,
        protocol,
        status: response.status,
        detail: `${protocol} probe returned ${response.status}`,
      };
    let capabilities: ServiceCapabilities | undefined;
    if (protocol !== "http") {
      const body = JSON.parse(response.body.toString("utf8")) as unknown;
      const models = protocol === "openai-model-list" ? parseOpenAIModelList(body) : undefined;
      if (protocol === "comfyui" && (!body || typeof body !== "object"))
        return {
          name: service.name,
          reachable: false,
          protocol,
          status: response.status,
          detail: "ComfyUI system-stats response was invalid",
        };
      if (["audio", "tts", "stt"].includes(protocol) && (!body || typeof body !== "object"))
        return {
          name: service.name,
          reachable: false,
          protocol,
          status: response.status,
          detail: "Audio health response was invalid",
        };
      if (protocol === "openai-model-list") {
        if (!models)
          return {
            name: service.name,
            reachable: false,
            protocol,
            status: response.status,
            detail: "model-list response was invalid",
          };
        capabilities = { models };
      } else capabilities = { response: body as Record<string, unknown> };
    }
    return {
      name: service.name,
      reachable: true,
      protocol,
      status: response.status,
      detail: `${protocol} probe passed`,
      ...(capabilities ? { capabilities } : {}),
    };
  } catch (error) {
    return {
      name: service.name,
      reachable: false,
      protocol,
      status: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function acquireLock(service: string): string {
  const file = lockPath(service);
  mkdirSync(dataFile("locks"), { recursive: true });
  try {
    const fd = openSync(file, "wx", 0o600);
    writeFileSync(fd, JSON.stringify({ pid: process.pid, service, createdAt: Date.now() }));
    closeSync(fd);
    return file;
  } catch (error: any) {
    try {
      if (statSync(file).size <= MAX_LOCK_RECORD_BYTES) {
        const record = parseLockRecord(readFileSync(file, "utf8"), service);
        if (record && !processExists(record.pid)) {
          unlinkSync(file);
          return acquireLock(service);
        }
      }
    } catch {}
    throw new Error("service start is already locked by another Iris process", { cause: error });
  }
}

export function startOwnedService(service: AdminConfig["services"][number]): OwnedProcess {
  if (!service.process || service.mode === "connect-only") throw new Error("service is not startable");
  if (!executablePath(service.process.executable, service.process.workingDirectory))
    throw new Error(`process executable '${service.process.executable}' was not found`);
  const current = owned.get(service.name);
  if (current && current.child.exitCode === null) return current;
  const lockFile = acquireLock(service.name);
  try {
    const configPath = audioCppConfigPath(service);
    writeAudioCppConfig(service, configPath);
    const args = service.process.arguments.map((arg) => (arg === "{audioCppConfig}" ? configPath : arg));
    const child = spawn(service.process.executable, args, {
      cwd: service.process.workingDirectory,
      env: managedProcessEnvironment(service.process.environment),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    if (!child.pid) throw new Error("service process did not start");
    const logs: string[] = [];
    const capture = (chunk: Buffer) => {
      logs.push(
        chunk
          .toString()
          .replace(/(key|token|secret|password)(?:\s*[:=]\s*)\S+/gi, "$1=[redacted]")
          .slice(0, 2000),
      );
      if (logs.length > 50) logs.shift();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const record = {
      service: service.name,
      pid: child.pid,
      startedAt: Date.now(),
      processStartIdentity: processIdentity(child.pid),
      processGroupId: process.platform !== "win32" ? child.pid : null,
      child,
      logs,
      lockFile,
    };
    owned.set(service.name, record);
    setGauge("services.active", owned.size);
    const cleanup = () => {
      if (owned.get(service.name)?.pid === record.pid) {
        owned.delete(service.name);
        setGauge("services.active", owned.size);
      }
      try {
        unlinkSync(lockFile);
      } catch {}
    };
    child.once("exit", cleanup);
    child.once("error", cleanup);
    return record;
  } catch (error) {
    try {
      unlinkSync(lockFile);
    } catch {}
    throw error;
  }
}

export async function ensureService(
  service: AdminConfig["services"][number],
  signal?: AbortSignal,
): Promise<{ process: OwnedProcess | null; readiness: ServiceProbe; reused: boolean }> {
  if (signal?.aborted) throw new Error("operation aborted");
  if (service.mode === "connect-only") return { process: null, readiness: await probeService(service), reused: true };
  if (service.mode === "connect-or-start") {
    const existing = await probeService(service);
    if (existing.reachable) return { process: null, readiness: existing, reused: true };
  }
  increment("services.starts");
  let process: OwnedProcess;
  try {
    process = startOwnedService(service);
  } catch (error) {
    increment("services.start_failures");
    throw error;
  }
  const readiness = await waitForReadiness(service, service.endpoint.startupTimeoutSeconds * 1000, signal, process);
  if (!readiness.reachable) increment("services.readiness_failures");
  if (signal?.aborted) {
    stopOwnedService(service.name);
    throw new Error("operation aborted");
  }
  return { process, readiness, reused: false };
}

export async function waitForReadiness(
  service: AdminConfig["services"][number],
  timeoutMs = service.endpoint.startupTimeoutSeconds * 1000,
  signal?: AbortSignal,
  ownedProcess?: OwnedProcess,
): Promise<ServiceProbe> {
  const deadline = Date.now() + timeoutMs;
  let last = await probeService(service);
  while (
    !last.reachable &&
    Date.now() < deadline &&
    !signal?.aborted &&
    (!ownedProcess || ownedProcess.child.exitCode === null)
  ) {
    await new Promise((r) => setTimeout(r, 250));
    last = await probeService(service);
  }
  if (!last.reachable && ownedProcess && ownedProcess.child.exitCode !== null)
    return {
      ...last,
      detail: `process exited with code ${ownedProcess.child.exitCode}${ownedProcess.logs.length ? `: ${ownedProcess.logs.slice(-4).join(" ")}` : ""}`,
    };
  return last;
}
export function ownedProcessMayStop(expectedIdentity: string, currentIdentity: string | null): boolean {
  return currentIdentity !== null && expectedIdentity === currentIdentity;
}
export function stopOwnedService(name: string): boolean {
  const record = owned.get(name);
  if (!record) return false;
  if (!ownedProcessMayStop(record.processStartIdentity, processIdentity(record.pid))) return false;
  if (record.processGroupId !== null) {
    try {
      process.kill(-record.processGroupId, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        try {
          record.child.kill("SIGTERM");
        } catch {
          increment("services.stop_failures");
        }
      }
    }
  } else {
    try {
      record.child.kill("SIGTERM");
    } catch {
      increment("services.stop_failures");
    }
  }
  owned.delete(name);
  setGauge("services.active", owned.size);
  try {
    unlinkSync(record.lockFile);
  } catch {}
  return true;
}
/** Stop only processes started and still owned by this backend instance. */
export function stopAllOwnedServices(): void {
  for (const service of [...owned.keys()]) stopOwnedService(service);
  setGauge("services.active", owned.size);
}
export function listOwnedServices(): Array<{
  service: string;
  pid: number;
  startedAt: number;
  processStartIdentity: string;
  logs: string[];
}> {
  return [...owned.values()].map(({ service, pid, startedAt, processStartIdentity, logs }) => ({
    service,
    pid,
    startedAt,
    processStartIdentity,
    logs: [...logs],
  }));
}
