import { describe, expect, it } from "vitest";
import { createRuntimeConfig, resolveProviderBaseUrl } from "../src/config/runtime.js";
import type { SetupSettings } from "../src/setup/settings.js";

const settings: SetupSettings = {
  version: 1,
  defaultModel: { apiRouter: "llamacpp", model: "", maxContext: 8192 },
  modelProviders: { llamacppBaseUrl: "http://localhost:8080/v1", openAiCompatBaseUrl: "https://api.openai.com/v1" },
  providers: {},
  server: {
    host: "127.0.0.1",
    port: 3000,
    publicUrl: "http://localhost:3000/",
    trustedOrigins: ["http://localhost:5173", "HTTP://LOCALHOST:5173", "http://192.168.4.*:5173", "tauri://localhost"],
  },
};

describe("runtime origin configuration", () => {
  it("normalizes, deduplicates, and preserves valid wildcard origins", () => {
    const config = createRuntimeConfig(settings);
    expect(config.hostname).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
    expect(config.guestChatKeep).toBe(200);
    expect(config.guestAiName).toBe("iris");
    expect(config.guestModel).toBe("");
    expect(config.llamacppBaseUrl).toBe("http://localhost:8080/v1");
    expect(config.openAiCompatBaseUrl).toBe("https://api.openai.com/v1");
    expect(config.publicUrl).toBe("http://localhost:3000");
    expect(config.trustedOrigins).toEqual(["http://localhost:5173", "http://192.168.4.*:5173"]);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("uses environment values as a separate public URL and origin list", () => {
    const config = createRuntimeConfig(settings, {
      IRIS_PUBLIC_URL: "https://example.test/",
      IRIS_HOST: "backend.example.test",
      IRIS_PORT: "4312",
      IRIS_GUEST_CHAT_KEEP: "500",
      IRIS_GUEST_AI_NAME: "Test assistant",
      IRIS_GUEST_MODEL: "model-x",
      IRIS_TRUSTED_ORIGINS: "https://app.example.test, https://app.example.test, https://other.example.test/",
      IRIS_LLAMACPP_BASE_URL: "http://llama.example.test/v1/",
      IRIS_OPENAI_COMPAT_BASE_URL: "https://api.example.test/v1/",
    });
    expect(config.publicUrl).toBe("https://example.test");
    expect(config.hostname).toBe("backend.example.test");
    expect(config.port).toBe(4312);
    expect(config.guestChatKeep).toBe(500);
    expect(config.guestAiName).toBe("Test assistant");
    expect(config.guestModel).toBe("model-x");
    expect(config.trustedOrigins).toEqual(["https://app.example.test", "https://other.example.test"]);
    expect(config.llamacppBaseUrl).toBe("http://llama.example.test/v1");
    expect(config.openAiCompatBaseUrl).toBe("https://api.example.test/v1");
  });

  it("accepts the default sentinel and provider-defined model IDs", () => {
    expect(createRuntimeConfig(settings, { IRIS_GUEST_MODEL: "default" }).guestModel).toBe("default");
    expect(createRuntimeConfig(settings, { IRIS_GUEST_MODEL: "provider/org:model-v2.1_quantized" }).guestModel).toBe(
      "provider/org:model-v2.1_quantized",
    );
  });

  it("resolves provider URLs with profile, environment, then setup precedence", () => {
    const cases = [
      [
        "llamacpp",
        "http://profile.test/v1",
        { IRIS_LLAMACPP_BASE_URL: "http://env.test/v1" },
        "http://profile.test/v1",
      ],
      ["llamacpp", undefined, { IRIS_LLAMACPP_BASE_URL: "http://env.test/v1" }, "http://env.test/v1"],
      ["openai-compat", undefined, {}, "https://api.openai.com/v1"],
    ] as const;
    for (const [router, profile, env, expected] of cases) {
      expect(resolveProviderBaseUrl(settings, router, profile, env)).toBe(expected);
    }
  });

  it("converges startup and admin-edited provider projections without mutating env defaults", () => {
    const env = { IRIS_OPENAI_COMPAT_BASE_URL: "https://env.example.test/v1" };
    const startup = resolveProviderBaseUrl(settings, "openai-compat", undefined, env);
    const adminEdited = {
      ...settings,
      providers: { assistant: { router: "openai-compat" as const, baseUrl: "https://admin.example.test/v1" } },
    };
    expect(startup).toBe("https://env.example.test/v1");
    expect(resolveProviderBaseUrl(adminEdited, "openai-compat", adminEdited.providers.assistant.baseUrl, env)).toBe(
      "https://admin.example.test/v1",
    );
    expect(resolveProviderBaseUrl(settings, "openai-compat", undefined, env)).toBe(startup);
  });

  it("fails closed for invalid public URLs and drops invalid origins", () => {
    expect(() => createRuntimeConfig(settings, { IRIS_PUBLIC_URL: "https://user:pass@example.test/x" })).toThrow(
      "invalid public URL",
    );
    const config = createRuntimeConfig(settings, {
      IRIS_TRUSTED_ORIGINS: "https://good.test, javascript:alert(1), https://bad.test/path?token=secret",
    });
    expect(config.trustedOrigins).toEqual(["https://good.test"]);
    expect(() => createRuntimeConfig(settings, { IRIS_PORT: "70000" })).toThrow("invalid server port");
    expect(() => createRuntimeConfig(settings, { IRIS_HOST: "bad host" })).toThrow("invalid server host");
    expect(() => createRuntimeConfig(settings, { IRIS_GUEST_CHAT_KEEP: "0" })).toThrow("invalid guest chat retention");
    expect(() => createRuntimeConfig(settings, { IRIS_GUEST_AI_NAME: " " })).toThrow("invalid guest AI name");
    expect(() => createRuntimeConfig(settings, { IRIS_LLAMACPP_BASE_URL: "https://user:pass@host/v1" })).toThrow(
      "invalid llama.cpp base URL",
    );
    expect(() => createRuntimeConfig(settings, { IRIS_GUEST_MODEL: " " })).toThrow("invalid guest model");
    expect(() => createRuntimeConfig(settings, { IRIS_DEFAULT_MODEL: "provider/model\nname" })).toThrow(
      "invalid guest model",
    );
    expect(() => createRuntimeConfig(settings, { IRIS_GUEST_MODEL: "m".repeat(513) })).toThrow("invalid guest model");
  });
});
