export const isImmutableCommit = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);

export const audioInstallPayload = (backend: string, revision: string) => ({ backend, revision });
export const comfyInstallPayload = (revision: string) => ({ revision });
