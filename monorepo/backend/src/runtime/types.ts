// runtime/types.ts

export enum ProviderStatus {
  Waiting = "waiting",
  Busy = "busy",
  Inactive = "inactive",
  Error = "error",
}

export interface ProviderConfig {
  /** provider name, e.g. "files", "audio" */
  name: string;
  activeFunctionalities: string[];
  additionalSettings: Record<string, unknown>;
}
