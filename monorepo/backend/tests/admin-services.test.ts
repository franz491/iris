import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  probeService,
  serviceDefaults,
  setServiceLookupForTests,
  setServiceRequestForTests,
  startOwnedService,
  stopOwnedService,
  validateServiceDefinition,
} from "../src/admin/services.js";
import { metricsSnapshot, resetMetrics } from "../src/misc/metrics.js";
beforeEach(resetMetrics);
describe("admin service lifecycle", () => {
  it("requires a process for managed modes", () => {
    const errors = validateServiceDefinition({
      name: "x",
      kind: "llm",
      mode: "start-and-manage",
      endpoint: {
        baseUrl: "http://127.0.0.1:1",
        healthCheck: { protocol: "openai-model-list" },
        startupTimeoutSeconds: 2,
      },
      shutdownPolicy: "leave-running",
    });
    expect(errors).toContain("process is required for managed modes");
  });
  it("allows connect-only definitions without executable ownership", () => {
    expect(
      validateServiceDefinition({
        name: "x",
        kind: "comfyui",
        mode: "connect-only",
        endpoint: { baseUrl: "http://127.0.0.1:8188", healthCheck: { protocol: "comfyui" }, startupTimeoutSeconds: 2 },
        shutdownPolicy: "leave-running",
      }),
    ).toEqual([]);
  });
  it("resolves executable command names through PATH", () => {
    expect(
      validateServiceDefinition({
        name: "x",
        kind: "llm",
        mode: "start-and-manage",
        endpoint: {
          baseUrl: "http://127.0.0.1:1",
          healthCheck: { protocol: "openai-model-list" },
          startupTimeoutSeconds: 2,
        },
        process: { executable: "node", arguments: [], environment: {} },
        shutdownPolicy: "leave-running",
      }),
    ).toEqual([]);
  });
  it("rejects unsafe endpoint URL forms", () => {
    const base = {
      name: "x",
      kind: "llm",
      mode: "connect-only",
      endpoint: { baseUrl: "file:///tmp/iris", healthCheck: { protocol: "http" }, startupTimeoutSeconds: 2 },
      shutdownPolicy: "leave-running",
    } as const;
    expect(validateServiceDefinition(base)).toContain("endpoint.baseUrl must use http or https");
    expect(
      validateServiceDefinition({ ...base, endpoint: { ...base.endpoint, baseUrl: "https://user:pass@example.test" } }),
    ).toContain("endpoint.baseUrl must not contain credentials");
  });
  it("rejects cloud metadata and link-local targets", () => {
    const base = {
      name: "x",
      kind: "llm",
      mode: "connect-only",
      endpoint: { baseUrl: "http://127.0.0.1:1", healthCheck: { protocol: "http" }, startupTimeoutSeconds: 2 },
      shutdownPolicy: "leave-running",
    } as const;
    expect(
      validateServiceDefinition({
        ...base,
        endpoint: { ...base.endpoint, baseUrl: "http://169.254.169.254/latest/meta-data" },
      }),
    ).toContain("endpoint.baseUrl targets a blocked metadata or link-local host");
    expect(
      validateServiceDefinition({
        ...base,
        endpoint: { ...base.endpoint, baseUrl: "http://metadata.google.internal" },
      }),
    ).toContain("endpoint.baseUrl targets a blocked metadata or link-local host");
  });
});
describe("service defaults", () => {
  it("provides launch-ready llama.cpp and unified audio.cpp presets", () => {
    const defaults = serviceDefaults();
    expect(["llama", "llama-server"]).toContain(defaults.llm.process?.executable);
    expect(defaults.llm.process?.arguments.includes("serve")).toBe(defaults.llm.process?.executable === "llama");
    expect(defaults.llm.endpoint.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(defaults.audio.kind).toBe("audio");
    expect(defaults.audio.process?.executable).toBe("audiocpp_server");
    expect(defaults.audio.process?.arguments[0]).toBe("--config");
    expect(defaults.audio.process?.arguments[1]).toMatch(/audio-cpp\/audio\.cpp\.json$/);
    expect(defaults.audio.audioCpp?.family).toBe("pocket_tts");
    expect(defaults.audio.audioCpp?.asrModel?.family).toBe("qwen3_asr");
  });
});

describe("remote service response validation", () => {
  beforeEach(() =>
    setServiceRequestForTests(async (url) => {
      const response = await fetch(url);
      return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
    }),
  );
  afterEach(() => {
    vi.unstubAllGlobals();
    setServiceLookupForTests();
    setServiceRequestForTests();
  });
  const service = {
    name: "models",
    kind: "llm",
    mode: "connect-only",
    endpoint: {
      baseUrl: "http://127.0.0.1:8080/v1",
      healthCheck: { protocol: "openai-model-list" },
      startupTimeoutSeconds: 2,
    },
    shutdownPolicy: "leave-running",
  } as const;
  it("preserves valid model-list capabilities", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ object: "list", data: [{ id: "model-a" }, { id: "model-b", owned_by: "local" }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    );
    const result = await probeService(service);
    expect(result.reachable).toBe(true);
    expect(result.capabilities).toEqual({ models: ["model-a", "model-b"] });
  });
  it.each([
    null,
    [],
    {},
    { data: [null] },
    { data: [{ id: 42 }] },
    { data: [{ id: "" }] },
    { data: [{ id: "x".repeat(1025) }] },
    { data: Array.from({ length: 4097 }, () => ({ id: "model" })) },
  ])("fails closed for malformed model-list response %#", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    const result = await probeService(service);
    expect(result.reachable).toBe(false);
    expect(result.capabilities).toBeUndefined();
  });
  it("rejects a hostname resolving to a private address before fetch", async () => {
    setServiceLookupForTests(async () => [{ address: "192.168.1.20", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeService({
      ...service,
      endpoint: { ...service.endpoint, baseUrl: "http://model.internal:8080" },
    });
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain("disallowed private");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("allows deterministic localhost service resolution", async () => {
    setServiceLookupForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const result = await probeService({
      ...service,
      endpoint: { ...service.endpoint, baseUrl: "http://localhost:8080" },
    });
    expect(result.reachable).toBe(true);
  });
  it("rejects arbitrary hostnames resolving to loopback", async () => {
    setServiceLookupForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
    const result = await probeService({
      ...service,
      endpoint: { ...service.endpoint, baseUrl: "http://attacker.example:8080" },
    });
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain("may not resolve to loopback");
  });
  it.each(["::ffff:169.254.169.254", "ff02::1"])("rejects dangerous IPv6 address %s", async (address) => {
    setServiceLookupForTests(async () => [{ address, family: 6 }]);
    const result = await probeService({
      ...service,
      endpoint: { ...service.endpoint, baseUrl: "http://danger.example:8080" },
    });
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain("disallowed");
  });
  it("fails when a plain HTTP probe exceeds the response limit", async () => {
    setServiceRequestForTests(async () => ({ status: 200, body: Buffer.alloc(2 * 1024 * 1024 + 1) }));
    const result = await probeService({
      ...service,
      endpoint: { ...service.endpoint, baseUrl: "http://localhost:8080", healthCheck: { protocol: "http" } },
    });
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain("exceeded 2 MiB");
  });
});

describe("managed service lock recovery", () => {
  const lockFileFor = (name: string) =>
    join(
      process.env.IRIS_DATA_DIR!,
      "locks",
      `service-${createHash("sha256").update(name).digest("hex").slice(0, 24)}.lock`,
    );
  const service = (name: string) =>
    ({
      name,
      kind: "llm",
      mode: "start-and-manage",
      endpoint: { baseUrl: "http://127.0.0.1:1", healthCheck: { protocol: "http" }, startupTimeoutSeconds: 1 },
      process: { executable: process.execPath, arguments: ["-e", "setInterval(()=>{},10000)"], environment: {} },
      shutdownPolicy: "leave-running",
    }) as const;

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, "123", null])(
    "does not recover a malformed persisted PID (%s)",
    (pid) => {
      const current = service(`malformed-lock-${String(pid)}`);
      mkdirSync(join(process.env.IRIS_DATA_DIR!, "locks"), { recursive: true });
      writeFileSync(lockFileFor(current.name), JSON.stringify({ pid, service: current.name, createdAt: Date.now() }));
      expect(() => startOwnedService(current)).toThrow("service start is already locked");
    },
  );

  it("recovers a stale lock with a bounded valid PID", () => {
    const current = service("stale-lock");
    mkdirSync(join(process.env.IRIS_DATA_DIR!, "locks"), { recursive: true });
    writeFileSync(
      lockFileFor(current.name),
      JSON.stringify({ pid: 2_147_483_647, service: current.name, createdAt: Date.now() }),
    );
    const record = startOwnedService(current);
    try {
      expect(record.pid).toBeGreaterThan(0);
      expect(metricsSnapshot().gauges["services.active"]).toBe(1);
    } finally {
      stopOwnedService(current.name);
      expect(metricsSnapshot().gauges["services.active"]).toBe(0);
    }
  });
});

describe("managed process ownership", () => {
  it("passes only launch-safe inherited environment and explicit service variables", async () => {
    const probeFile = join(process.env.IRIS_DATA_DIR!, "environment.json");
    const inheritedSecret = "iris-inherited-secret";
    const priorSecret = process.env.IRIS_MANAGED_SERVICE_SECRET;
    process.env.IRIS_MANAGED_SERVICE_SECRET = inheritedSecret;
    const service = {
      name: "environment-test",
      kind: "llm",
      mode: "start-and-manage",
      endpoint: { baseUrl: "http://127.0.0.1:1", healthCheck: { protocol: "http" }, startupTimeoutSeconds: 1 },
      process: {
        executable: process.execPath,
        arguments: [
          "-e",
          "require('node:fs').writeFileSync(process.env.IRIS_ENV_PROBE_FILE,JSON.stringify({path:process.env.PATH,secret:process.env.IRIS_MANAGED_SERVICE_SECRET,configured:process.env.IRIS_EXPLICIT_SERVICE_VALUE}))",
        ],
        environment: { IRIS_ENV_PROBE_FILE: probeFile, IRIS_EXPLICIT_SERVICE_VALUE: "explicit-value" },
      },
      shutdownPolicy: "leave-running",
    } as const;
    const record = startOwnedService(service);
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(probeFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      const environment = JSON.parse(readFileSync(probeFile, "utf8")) as {
        path?: string;
        secret?: string;
        configured?: string;
      };
      expect(environment.path).toBe(process.env.PATH);
      expect(environment.secret).toBeUndefined();
      expect(environment.configured).toBe("explicit-value");
    } finally {
      stopOwnedService(service.name);
      if (priorSecret === undefined) delete process.env.IRIS_MANAGED_SERVICE_SECRET;
      else process.env.IRIS_MANAGED_SERVICE_SECRET = priorSecret;
    }
  });
  it.skipIf(process.platform === "win32")("stops descendants with the owned process group", async () => {
    const pidFile = join(process.env.IRIS_DATA_DIR!, "descendant.pid");
    const service = {
      name: "group-test",
      kind: "llm",
      mode: "start-and-manage",
      endpoint: { baseUrl: "http://127.0.0.1:1", healthCheck: { protocol: "http" }, startupTimeoutSeconds: 1 },
      process: {
        executable: process.execPath,
        arguments: [
          "-e",
          "const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});fs.writeFileSync(process.env.IRIS_DESCENDANT_PID,String(c.pid));setInterval(()=>{},10000)",
        ],
        environment: { IRIS_DESCENDANT_PID: pidFile },
      },
      shutdownPolicy: "leave-running",
    } as const;
    const record = startOwnedService(service);
    try {
      const deadline = Date.now() + 3000;
      while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(existsSync(pidFile)).toBe(true);
      const descendantPid = Number(readFileSync(pidFile, "utf8"));
      expect(descendantPid).toBeGreaterThan(0);
      expect(stopOwnedService(service.name)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => process.kill(record.pid, 0)).toThrow();
      expect(() => process.kill(descendantPid, 0)).toThrow();
    } finally {
      stopOwnedService(service.name);
    }
  });
});
