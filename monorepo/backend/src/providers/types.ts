// providers/types.ts

// Schemas are plain records (JSON schema objects); kept loose to allow
// zod-to-json-schema output.
export type SchemaObject = Record<string, unknown>;

export interface ProviderFunctionality {
  name: string;
  description: string;
  /** JSON schema for the kwargs object */
  kwargsSchema: SchemaObject;
  /** JSON schema for the return value */
  returnSchema: SchemaObject;
}

export interface ProviderDescriptor {
  name: string;
  description: string;
  options: ProviderFunctionality[];
  /** JSON schema describing the provider's additional config settings */
  additionalConfig: SchemaObject;
}

export interface ProviderRequest<K = unknown> {
  provider: string;
  functionality: string;
  kwargs: K;
}
