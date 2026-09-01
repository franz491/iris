import { getAdminConfig, getChecklist, getPatch, stagePatch, validatePatch, applyPatch, testPatch } from "./store.js";
import { redactSecrets, type AdminConfig } from "./schema.js";
const SETUP_SECTIONS = ["server", "services", "profiles", "secrets", "tools", "prompts", "cache"] as const;
type SetupSection = (typeof SETUP_SECTIONS)[number];
function isSetupSection(section: string): section is SetupSection {
  return (SETUP_SECTIONS as readonly string[]).includes(section);
}
export function setupListSections(): string[] {
  return [...SETUP_SECTIONS];
}
export function setupReadSection(section: string): unknown {
  const { config } = getAdminConfig();
  if (!isSetupSection(section)) throw new Error("unknown setup section");
  const value: AdminConfig[SetupSection] = config[section];
  return section === "secrets" ? redactSecrets(value) : value;
}
export function setupGetOptions(section: string): unknown {
  const options: Record<string, unknown> = {
    server: { tlsModes: ["localhost-only", "existing-certificate", "self-signed", "reverse-proxy", "acme"] },
    services: { kinds: ["llm", "audio", "comfyui"], modes: ["connect-only", "start-and-manage", "connect-or-start"] },
    profiles: { accelerations: ["cpu", "cuda", "rocm", "vulkan", "metal", "remote"] },
    secrets: { states: ["unset", "configured", "invalid"] },
  };
  return options[section] ?? {};
}
export function setupCurrentSummary(): string {
  const { version, config } = getAdminConfig();
  const services =
    config.services.map((service) => `${service.name} (${service.kind}, ${service.mode})`).join(", ") || "none";
  const profiles =
    config.profiles.map((profile) => `${profile.name}${profile.model ? ` → ${profile.model}` : ""}`).join(", ") ||
    "none";
  const tools =
    Object.entries(config.tools)
      .filter(([, value]) => value.active.length > 0)
      .map(([name, value]) => `${name}: ${value.active.join(", ")}`)
      .join("; ") || "none";
  return [
    `Current applied administrator configuration (version ${version}):`,
    `- services: ${services}`,
    `- model profiles: ${profiles}`,
    `- active AI tools: ${tools}`,
    `- TTS replay cache: ${config.cache.enabled ? "enabled" : "disabled"}`,
    "- setup checklist:",
    ...getChecklist().map((item) => `  - ${item.group}: ${item.state}`),
  ].join("\n");
}
export function setupProposePatch(actorId: string, patch: unknown) {
  return stagePatch(actorId, patch);
}
export async function setupValidatePatch(actorId: string, id: string) {
  validatePatch(id, actorId);
  return testPatch(id, actorId);
}
export function setupTestPatch(actorId: string, id: string) {
  return testPatch(id, actorId);
}
export async function setupApplyPatch(actorId: string, id: string) {
  const p = getPatch(id);
  if (!p) throw new Error("patch not found");
  return applyPatch(id, actorId);
}
