// tests/misc.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppError, toAppError, ValidationError } from "../src/misc/error.js";
import { isJsonObject, uuid, sleep } from "../src/misc/utils.js";
import {
  errorEvent,
  logger,
  MAX_LOG_BYTES,
  pseudonym,
  eventRecord,
  redactSensitiveText,
  setLogFile,
  setLogLevel,
} from "../src/misc/logging.js";

describe("misc", () => {
  it("creates stable bounded process-local pseudonyms and typed envelopes", () => {
    expect(pseudonym("actor-secret")).toMatch(/^p_[0-9a-f]{16}$/);
    expect(pseudonym("actor-secret")).toBe(pseudonym("actor-secret"));
    expect(pseudonym("actor-secret")).not.toBe(pseudonym("other-secret"));
    expect(eventRecord("chat", "warning", { actor_ref: pseudonym("actor-secret") }, "warn")).toMatchObject({
      level: "warn",
      actor_ref: pseudonym("actor-secret"),
    });
    const serialized = JSON.stringify(
      eventRecord("chat", "warning", { actor_ref: pseudonym("actor-secret"), chat_ref: pseudonym("chat-secret") }),
    );
    expect(serialized).not.toContain("actor-secret");
    expect(serialized).not.toContain("chat-secret");
  });
  it("serializes bounded error events without secret-bearing causes", () => {
    const event = errorEvent(
      "kernel",
      "provider.initialize.failed",
      "provider_init_failed",
      "corr-1",
      new Error('apiKey="secret" password=pw token=tok'),
    );
    expect(event).toMatchObject({
      component: "kernel",
      event: "provider.initialize.failed",
      code: "provider_init_failed",
      correlationId: "corr-1",
    });
    expect(JSON.stringify(event)).not.toContain('apiKey="secret"');
    expect(JSON.stringify(event)).not.toContain("password=pw");
    expect(JSON.stringify(event)).not.toContain("token=tok");
  });
  it("error utilities wrap unknowns", () => {
    expect(toAppError(new ValidationError("bad")).code).toBe("validation_error");
    expect(toAppError(new Error("boom")).code).toBe("internal_error");
    expect(toAppError("weird").message).toBe("weird");
    expect(new AppError("x") instanceof Error).toBe(true);
  });

  it("classifies JSON parse failures as validation errors", () => {
    const error = toAppError(new SyntaxError("Unexpected token"));
    expect(error.code).toBe("validation_error");
    expect(error.message).toBe("invalid JSON payload");
  });

  it("utils behave", async () => {
    expect(isJsonObject({ a: 1 })).toBe(true);
    expect(isJsonObject([1])).toBe(false);
    expect(uuid()).not.toBe(uuid());
    const start = Date.now();
    await sleep(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
    expect(() => setLogLevel("info")).not.toThrow();
  });

  it("redacts credentials from logger text and structured errors", () => {
    expect(
      redactSensitiveText("Authorization: Bearer abc123 cookie=session=xyz sk-live-secret apiKey=key-value"),
    ).not.toMatch(/abc123|session=xyz|sk-live-secret|key-value/);

    const error = new Error("provider failed: token=err-secret");
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      logger("redaction-test").error(
        "request failed Authorization: Bearer log-secret Cookie: sid=abc",
        { api_key: "object-secret" },
        error,
      );
      const line = output.mock.calls[0]?.[0] as string;
      expect(line).toContain("[REDACTED]");
      expect(line).not.toMatch(/log-secret|sid=abc|object-secret|err-secret/);
    } finally {
      output.mockRestore();
    }
  });

  it("rotates file logs before exceeding the bounded size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iris-log-"));
    const path = join(dir, "app.log");
    writeFileSync(path, "x".repeat(MAX_LOG_BYTES));
    writeFileSync(`${path}.1`, "stale-rotated-log");
    setLogFile(path);
    logger("rotation").info("rotation-secret");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(statSync(`${path}.1`).size).toBe(MAX_LOG_BYTES);
    expect(readFileSync(path, "utf8")).toContain("rotation-secret");
    setLogFile(null);
  });
});
