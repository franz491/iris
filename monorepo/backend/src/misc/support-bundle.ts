import { redactSensitiveText } from "./logging.js";
import { redactSecrets } from "../admin/schema.js";

const MAX_BYTES = 256 * 1024;
export interface SupportBundleInput {
  version: string;
  readiness: string;
  metrics: Record<string, unknown>;
  configSummary: Record<string, unknown>;
  audit: unknown[];
}
/** Deterministic, bounded diagnostic export. Callers must supply allowlisted data. */
export function createSupportBundle(input: SupportBundleInput): string {
  const safe = {
    format: "iris.support-bundle",
    version: input.version,
    readiness: input.readiness,
    metrics: input.metrics,
    configSummary: input.configSummary,
    audit: input.audit,
  };
  const sanitized = redactSecrets(safe);
  const removeSensitive = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(removeSensitive);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/path|prompt|message|body|args|results?|cookie/i.test(key))
        .map(([key, item]) => [key, removeSensitive(item)]),
    );
  };
  const json = redactSensitiveText(JSON.stringify(removeSensitive(sanitized), null, 2));
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error("support bundle exceeds size limit");
  return `${json}\n`;
}
