import { accessSync, constants, readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
export type TlsMode = "localhost-only" | "existing-certificate" | "self-signed" | "reverse-proxy" | "acme";
export interface TlsConfig {
  mode: TlsMode;
  hostname?: string;
  certificatePath?: string;
  keyPath?: string;
  trustedOrigins: string[];
}
export function validateTls(config: TlsConfig): string[] {
  const e: string[] = [];
  if (
    !Array.isArray(config.trustedOrigins) ||
    config.trustedOrigins.some((x) => {
      try {
        new URL(x);
        return false;
      } catch {
        return true;
      }
    })
  )
    e.push("trusted origins must be absolute URLs");
  if (config.mode === "existing-certificate") {
    if (!config.certificatePath || !config.keyPath) e.push("certificate and key paths are required");
    else {
      try {
        accessSync(config.certificatePath, constants.R_OK);
        accessSync(config.keyPath, constants.R_OK);
        const cert = new X509Certificate(readFileSync(config.certificatePath));
        if (cert.validToDate.getTime() < Date.now()) e.push("certificate is expired");
        if (config.hostname && !cert.checkHost(config.hostname)) e.push("certificate does not cover hostname");
      } catch {
        e.push("certificate or key is unreadable/invalid");
      }
    }
  }
  if (config.mode === "acme" && !config.hostname) e.push("ACME requires a hostname");
  return e;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}
