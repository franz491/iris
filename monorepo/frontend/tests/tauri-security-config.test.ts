import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(frontendRoot, path), "utf8"));

describe("Tauri security configuration", () => {
  it("uses a restrictive CSP compatible with Tauri IPC and configured backends", () => {
    const config = readJson("src-tauri/tauri.conf.json") as {
      app: { security: { csp: string } };
    };
    const csp = config.app.security.csp;

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'self' ipc: http://ipc.localhost");
    expect(csp).not.toContain("script-src 'unsafe-inline'");
    expect(csp).not.toContain("script-src 'unsafe-eval'");
  });

  it("grants only the used dialog and external HTTP(S) link capabilities", () => {
    const config = readJson("src-tauri/tauri.conf.json") as {
      plugins: { shell: { open: string } };
    };
    const capability = readJson("src-tauri/capabilities/default.json") as {
      permissions: string[];
    };

    expect(capability.permissions).toEqual(["core:default", "shell:allow-open", "dialog:allow-open"]);
    expect(capability.permissions.some((permission) => permission.startsWith("fs:"))).toBe(false);
    expect(config.plugins.shell.open).toContain("https?");
    expect(config.plugins.shell.open).not.toContain("mailto");
    expect(config.plugins.shell.open).not.toContain("tel");
  });
});
