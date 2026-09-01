import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { originMatches, readSetupSettings, setupSettingsPath } from "../src/setup/settings.js";

describe("setup origin policy", () => {
  it("matches exact local origins", () => {
    expect(originMatches("http://localhost:5173", ["http://localhost:5173"])).toBe(true);
    expect(originMatches("http://localhost:5174", ["http://localhost:5173"])).toBe(false);
  });

  it("supports a private /24-style wildcard with arbitrary frontend ports", () => {
    const patterns = ["http://192.168.4.*:*"];
    expect(originMatches("http://192.168.4.20:5173", patterns)).toBe(true);
    expect(originMatches("http://192.168.5.20:5173", patterns)).toBe(false);
    expect(originMatches("https://192.168.4.20:5173", patterns)).toBe(false);
  });
});

describe("setup settings file validation", () => {
  it("falls back to defaults when the JSON root is not a settings object", () => {
    writeFileSync(setupSettingsPath(), JSON.stringify(null));

    expect(readSetupSettings()).toMatchObject({
      version: 1,
      defaultModel: { apiRouter: "llamacpp", maxContext: 8192 },
      server: { host: "127.0.0.1", port: 3000 },
    });
  });

  it("falls back to defaults when a nested setting has the wrong type", () => {
    writeFileSync(
      setupSettingsPath(),
      JSON.stringify({
        server: { trustedOrigins: "*" },
        providers: { unsafe: { router: "llamacpp", baseUrl: 42 } },
      }),
    );

    const settings = readSetupSettings();
    expect(settings).toMatchObject({
      providers: {},
      server: { trustedOrigins: expect.arrayContaining(["http://localhost:5173", "http://127.0.0.1:5173"]) },
    });
    expect(settings.server.trustedOrigins).toHaveLength(5);
  });

  it("rejects unknown keys instead of merging unvalidated JSON", () => {
    writeFileSync(setupSettingsPath(), JSON.stringify({ server: { host: "0.0.0.0", unexpected: true } }));

    expect(readSetupSettings()).toMatchObject({ server: { host: "127.0.0.1" } });
  });

  it("keeps valid partial settings compatible with default merging", () => {
    writeFileSync(setupSettingsPath(), JSON.stringify({ server: { host: "0.0.0.0" } }));

    expect(readSetupSettings()).toMatchObject({
      server: { host: "0.0.0.0", port: 3000, publicUrl: "http://localhost:3000" },
    });
  });
});
