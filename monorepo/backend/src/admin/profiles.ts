import type { AdminConfig } from "./schema.js";
export function validateProfiles(config: AdminConfig): string[] {
  const services = new Map(config.services.map((s) => [s.name, s]));
  const names = new Set(config.profiles.map((p) => p.name));
  const errors: string[] = [];
  for (const p of config.profiles) {
    if (!services.has(p.service)) errors.push(`profile ${p.name} references unknown service ${p.service}`);
    if (p.fallback && !names.has(p.fallback))
      errors.push(`profile ${p.name} references unknown fallback ${p.fallback}`);
    if (p.fallback === p.name) errors.push(`profile ${p.name} cannot fall back to itself`);
    if (p.sttService && !(["stt", "audio"] as string[]).includes(services.get(p.sttService)?.kind ?? ""))
      errors.push(`profile ${p.name} references invalid speech service ${p.sttService}`);
  }
  return errors;
}
