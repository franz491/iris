import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

beforeEach(() => {
  process.env.IRIS_DATA_DIR = mkdtempSync(path.join(tmpdir(), "iris-model-manager-"));
  process.env.IRIS_API_KEYS_MASTER_KEY = Buffer.alloc(32, 19).toString("base64");
  delete process.env.IRIS_API_KEYS_MASTER_KEY_FILE;
  vi.resetModules();
});

describe("model manager provider trust boundary", () => {
  it("uses the typed apiRouter to resolve provider-level request fields", async () => {
    const { migrateChatDb } = await import("../src/chat/database.js");
    migrateChatDb();
    const { setApiKey } = await import("../src/model-router/keys.js");
    setApiKey("provider-key", "sk-provider");

    const settings = await import("../src/setup/settings.js");
    const current = settings.readSetupSettings();
    settings.writeSetupSettings({
      ...current,
      providers: {
        ...current.providers,
        "typed-provider": {
          router: "openai-compat",
          baseUrl: "http://provider.test/v1",
          apiKeyName: "provider-key",
        },
      },
    });

    const manager = await import("../src/model-router/model-manager.js");
    let requestFields: Record<string, unknown> | undefined;
    manager.registerApiRouter("typed-provider", {
      async *complete(request) {
        requestFields = request.additionalFields;
        yield { delta: "" };
      },
      async completeOnce(request) {
        requestFields = request.additionalFields;
        return { content: "" };
      },
    });

    await manager.routeCompletionOnce(
      {
        model: "model",
        apiRouter: "typed-provider",
        apiAdditionalFields: {},
      },
      [],
    );

    expect(requestFields).toEqual({
      _apiKey: "sk-provider",
      _baseUrl: "http://provider.test/v1",
    });
  });
});
