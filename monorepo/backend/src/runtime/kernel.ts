// runtime/kernel.ts — orchestrates config-parser and providers.
import { getConfig, setConfig as persistConfig } from "./config-parser.js";
import type { ProviderConfig } from "./types.js";
import { ProviderStatus } from "./types.js";
import type { Provider } from "../providers/interfaces.js";
import type { ProviderFunctionality, ProviderRequest } from "../providers/types.js";
import { AppError, NotFoundError, toAppError } from "../misc/error.js";
import { errorEvent, eventRecord, logger } from "../misc/logging.js";
import {
  parseProviderContract,
  validateDescriptorJson,
  type ProviderContract,
  type ProviderContractKey,
} from "../providers/contracts.js";

const log = logger("kernel");

export interface Kernel {
  getStatus(providerName: string): ProviderStatus;
  getFunctionality(providerName: string): ProviderFunctionality[];
  useProvider(name: string, functionality: string, kwargs: unknown): Promise<unknown>;
  useProviderStream(
    name: string,
    functionality: string,
    source: AsyncIterable<Uint8Array>,
    kwargs: unknown,
  ): Promise<unknown>;
  useProviderContract<K extends ProviderContractKey>(key: K, kwargs: unknown): Promise<ProviderContract<K>>;
  setConfig(config: ProviderConfig[], force?: boolean): Promise<void>;
  sendRequest<K = unknown, R = unknown>(req: ProviderRequest<K>): Promise<R>;
  /** start the kernel: load configs and initialize providers */
  start(): Promise<void>;
}

interface ProviderEntry {
  provider: Provider;
  status: ProviderStatus;
  /** pending reconfiguration; replaced by newer setConfig calls for the same provider */
  pendingConfig: ProviderConfig | null;
  reconfigPromise: Promise<void> | null;
}

const registry = new Map<string, () => Provider>();

/** Register a provider factory under its descriptor name (called by installed/index.ts). */
export function registerProviderFactory(name: string, factory: () => Provider): void {
  registry.set(name, factory);
}

const entries = new Map<string, ProviderEntry>();

function getEntry(name: string): ProviderEntry {
  const e = entries.get(name);
  if (!e) throw new NotFoundError(`provider "${name}"`);
  return e;
}

async function initProvider(name: string, config: ProviderConfig, entry?: ProviderEntry) {
  const factory = registry.get(name);
  if (!factory) {
    log.warn(JSON.stringify(eventRecord("kernel", "provider.factory_missing", { outcome: "skipped" }, "warn")));
    return;
  }
  let e = entry;
  if (!e) {
    e = { provider: factory(), status: ProviderStatus.Waiting, pendingConfig: null, reconfigPromise: null };
    entries.set(name, e);
  }
  try {
    e.status = ProviderStatus.Busy;
    await e.provider.setConfig(config);
    e.status = ProviderStatus.Waiting;
    log.info(JSON.stringify(eventRecord("kernel", "provider.initialized")));
  } catch (err) {
    e.status = ProviderStatus.Error;
    log.error(
      JSON.stringify(errorEvent("kernel", "provider.initialize.failed", "provider_init_failed", undefined, err)),
    );
  }
}

/**
 * Reconfigure a provider. If busy, the reconfiguration is queued until the
 * provider stops being busy (unless forced). A newer setConfig for the same
 * provider replaces any queued one.
 */
async function reconfigure(name: string, config: ProviderConfig, force: boolean): Promise<void> {
  const e = entries.get(name);
  if (!e) {
    await initProvider(name, config);
    return;
  }
  if (e.status !== ProviderStatus.Busy || force) {
    e.pendingConfig = null;
    await initProvider(name, config, e);
    return;
  }
  // queue it (replacing previous queued config)
  e.pendingConfig = config;
  if (!e.reconfigPromise) {
    e.reconfigPromise = (async () => {
      while (e.pendingConfig) {
        const cfg = e.pendingConfig;
        e.pendingConfig = null;
        await initProvider(name, cfg, e);
      }
      e.reconfigPromise = null;
    })();
  }
}

export const kernel: Kernel = {
  getStatus(providerName) {
    return getEntry(providerName).status;
  },

  getFunctionality(providerName) {
    return getEntry(providerName).provider.providerDescriptor.options;
  },

  async useProvider(name: string, functionality: string, kwargs: unknown): Promise<unknown> {
    const e = getEntry(name);
    if (e.status === ProviderStatus.Inactive || e.status === ProviderStatus.Error) {
      throw new AppError(`provider "${name}" is ${e.status}`, "provider_unavailable");
    }
    if (!e.provider.providerDescriptor.options.some((f) => f.name === functionality)) {
      throw new AppError(`unknown functionality "${functionality}" on provider "${name}"`, "unknown_functionality");
    }
    const descriptor = e.provider.providerDescriptor.options.find((f) => f.name === functionality)!;
    validateDescriptorJson(kwargs, descriptor.kwargsSchema);
    try {
      e.status = ProviderStatus.Busy;
      try {
        const result = await e.provider.callFunctionality(functionality, kwargs);
        return validateDescriptorJson(result, descriptor.returnSchema);
      } finally {
        if (e.status === ProviderStatus.Busy) e.status = ProviderStatus.Waiting;
      }
    } catch (err) {
      throw toAppError(err);
    }
  },

  async useProviderStream(name, functionality, source, kwargs): Promise<unknown> {
    const e = getEntry(name);
    if (e.status === ProviderStatus.Inactive || e.status === ProviderStatus.Error) {
      throw new AppError(`provider "${name}" is ${e.status}`, "provider_unavailable");
    }
    if (!e.provider.callStreamFunctionality) {
      throw new AppError(`provider "${name}" does not support streaming`, "unknown_functionality");
    }
    try {
      e.status = ProviderStatus.Busy;
      try {
        return await e.provider.callStreamFunctionality(functionality, source, kwargs);
      } finally {
        if (e.status === ProviderStatus.Busy) e.status = ProviderStatus.Waiting;
      }
    } catch (error) {
      throw toAppError(error);
    }
  },

  async useProviderContract<K extends ProviderContractKey>(key: K, kwargs: unknown): Promise<ProviderContract<K>> {
    const separator = key.indexOf(".");
    if (separator < 1) throw new AppError("invalid provider contract", "invalid_provider_contract");
    const value = await this.useProvider(key.slice(0, separator), key.slice(separator + 1), kwargs);
    return parseProviderContract(key, value);
  },

  async setConfig(configs, force = false) {
    // persist to config DB, then apply
    for (const cfg of configs) {
      await persistConfig(cfg.name, cfg);
      await reconfigure(cfg.name, cfg, force);
    }
  },

  async sendRequest<K, R>(req: ProviderRequest<K>): Promise<R> {
    return this.useProvider(req.provider, req.functionality, req.kwargs) as Promise<R>;
  },

  async start() {
    const configs = await getConfig();
    for (const cfg of Object.values(configs)) {
      await initProvider(cfg.name, cfg);
    }
    log.info(JSON.stringify(eventRecord("kernel", "kernel.started", { count: Object.keys(configs).length })));
  },
};

/** Frozen exported kernel, per spec. */
export const frozenKernel: Kernel = Object.freeze(kernel);
