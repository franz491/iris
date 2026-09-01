import { describe, expect, it } from "vitest";
import { createRuntimeLimits } from "../src/config/runtime-limits.js";
import { declaresOversizedJson } from "../src/api/json-limits.js";

describe("runtime limits", () => {
  it("preserves defaults and freezes the parsed policy", () => {
    const limits = createRuntimeLimits({});
    expect(limits.jsonBodyBytes).toBe(1024 * 1024);
    expect(limits.jsonBodyTimeoutMs).toBe(30_000);
    expect(limits.attachmentBytes).toBe(10 * 1024 * 1024);
    expect(limits.openAiStreamBytes).toBe(8 * 1024 * 1024);
    expect(limits.toolArgumentBytes).toBe(64 * 1024);
    expect(limits.toolStorageBytes).toBe(256 * 1024);
    expect(limits.avatarBytes).toBe(256 * 1024);
    expect(limits.promptBytes).toBe(1_000_000);
    expect(limits.promptImportBytes).toBe(4 * 1024 * 1024);
    expect(limits.promptValueBytes).toBe(256 * 1024);
    expect(limits.promptKeyBytes).toBe(256);
    expect(limits.promptCount).toBe(1_000);
    expect(limits.logBytes).toBe(5 * 1024 * 1024);
    expect(limits.comfyJsonDepth).toBe(32);
    expect(limits.modelActive).toBe(2);
    expect(limits.credentialActive).toBe(2);
    expect(limits.configActive).toBe(1);
    expect(limits.uploadPerWindow).toBe(10);
    expect(limits.guestAccessPerWindow).toBe(30);
    expect(limits.guestMessagesPerWindow).toBe(20);
    expect(limits.serviceProbesPerWindow).toBe(10);
    expect(limits.abuseWindowMs).toBe(60_000);
    expect(limits.limiterKeyCapacity).toBe(20_000);
    expect(limits.chatInstanceCacheEntries).toBe(256);
    expect(limits.chatToolConfigEntries).toBe(256);
    expect(Object.isFrozen(limits)).toBe(true);
  });

  it("clamps valid configured values while rejecting malformed values", () => {
    const limits = createRuntimeLimits({
      IRIS_MAX_JSON_BODY_BYTES: "1",
      IRIS_JSON_BODY_TIMEOUT_MS: "999999999",
      IRIS_MAX_ATTACHMENT_BYTES: "1234567",
      IRIS_MAX_TOOL_ARGUMENT_BYTES: "1",
      IRIS_MAX_AVATAR_BYTES: "999999999",
      IRIS_MAX_PROMPT_BYTES: "16384",
      IRIS_MAX_LOG_BYTES: "1",
      IRIS_MAX_COMFY_JSON_KEYS: "999999999",
      IRIS_MAX_ACTIVE_MODEL_REQUESTS: "0",
      IRIS_MAX_ACTIVE_CREDENTIAL_OPERATIONS: "999",
      IRIS_MAX_ACTIVE_CONFIG_OPERATIONS: "0",
      IRIS_UPLOAD_LIMIT_PER_WINDOW: "999999",
      IRIS_GUEST_ACCESS_LIMIT_PER_WINDOW: "7",
      IRIS_SERVICE_PROBE_LIMIT_PER_WINDOW: "2",
      IRIS_GUEST_MESSAGE_LIMIT_PER_WINDOW: "3",
      IRIS_ABUSE_WINDOW_MS: "1",
      IRIS_LIMITER_KEY_CAPACITY: "99",
      IRIS_CHAT_INSTANCE_CACHE_ENTRIES: "1",
      IRIS_CHAT_TOOL_CONFIG_ENTRIES: "1",
    });
    expect(limits.jsonBodyBytes).toBe(16 * 1024);
    expect(limits.jsonBodyTimeoutMs).toBe(5 * 60_000);
    expect(limits.attachmentBytes).toBe(1_234_567);
    expect(limits.toolArgumentBytes).toBe(1024);
    expect(limits.avatarBytes).toBe(4 * 1024 * 1024);
    expect(limits.promptBytes).toBe(16384);
    expect(limits.logBytes).toBe(64 * 1024);
    expect(limits.comfyJsonKeys).toBe(1_000_000);
    expect(limits.modelActive).toBe(1);
    expect(limits.credentialActive).toBe(64);
    expect(limits.configActive).toBe(1);
    expect(limits.uploadPerWindow).toBe(10_000);
    expect(limits.guestAccessPerWindow).toBe(7);
    expect(limits.serviceProbesPerWindow).toBe(2);
    expect(limits.guestMessagesPerWindow).toBe(3);
    expect(limits.abuseWindowMs).toBe(1_000);
    expect(limits.limiterKeyCapacity).toBe(100);
    expect(limits.chatInstanceCacheEntries).toBe(16);
    expect(limits.chatToolConfigEntries).toBe(16);
    expect(() => createRuntimeLimits({ IRIS_MAX_AUDIO_HANDLE_BYTES: "not-a-number" })).toThrow(
      "IRIS_MAX_AUDIO_HANDLE_BYTES",
    );
    expect(() => createRuntimeLimits({ IRIS_MAX_STT_BYTES: "Infinity" })).toThrow("IRIS_MAX_STT_BYTES");
  });

  it("allows consumers to use an injected configured JSON limit", () => {
    const limits = createRuntimeLimits({ IRIS_MAX_JSON_BODY_BYTES: "16384" });
    const request = new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "16385" },
      body: "{}",
    });
    expect(declaresOversizedJson(request, limits.jsonBodyBytes)).toBe(true);
  });
});
