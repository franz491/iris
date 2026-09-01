// providers/base.ts — shared plumbing for installed providers.
import { EventEmitter } from "node:events";
import type { Provider } from "./interfaces.js";
import type { ProviderDescriptor } from "./types.js";
import type { ProviderConfig } from "../runtime/types.js";

export abstract class BaseProvider implements Provider {
  abstract readonly providerDescriptor: ProviderDescriptor;

  protected readonly events = new EventEmitter();
  protected config: ProviderConfig | null = null;

  constructor() {
    this.events.setMaxListeners(100);
  }

  abstract setConfig(newConfig: ProviderConfig): Promise<void>;

  /** Execute a functionality. Implementations should validate kwargs against the schema. */
  abstract callFunctionality(functionality: string, kwargs: unknown): Promise<unknown>;

  subscribe(event: string, callback: (payload: unknown) => void): () => void {
    this.events.on(event, callback);
    return () => this.events.off(event, callback);
  }

  /** Is the given functionality enabled in the active config? */
  isFunctionalityActive(name: string): boolean {
    return this.config?.activeFunctionalities.includes(name) ?? false;
  }

  /** Typed accessor for additional settings with fallback. */
  protected setting<T>(key: string, fallback: T): T {
    const v = this.config?.additionalSettings[key];
    return (v === undefined ? fallback : v) as T;
  }

  protected emit(event: string, payload?: unknown): void {
    this.events.emit(event, payload);
  }
}
