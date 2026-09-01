// providers/interfaces.ts
import type { ProviderConfig } from "../runtime/types.js";
import type { ProviderDescriptor } from "./types.js";

export interface Provider {
  readonly providerDescriptor: ProviderDescriptor;
  /** (Re)initialize the provider with a config. Called by the kernel. */
  setConfig(newConfig: ProviderConfig): Promise<void>;
  /**
   * Subscribe to provider events. Default event names: every functionality name,
   * plus "request", "response", "reload", "error".
   * Returns an unsubscribe function.
   */
  subscribe(event: string, callback: (payload: unknown) => void): () => void;

  /** Execute a functionality by name (kernel dispatch entrypoint). */
  callFunctionality(functionality: string, kwargs: unknown): Promise<unknown>;
  /** Optional non-JSON stream entrypoint for bounded internal transfers. */
  callStreamFunctionality?(functionality: string, source: AsyncIterable<Uint8Array>, kwargs: unknown): Promise<unknown>;
}
