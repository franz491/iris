import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

function provider(
  name: string,
  kwargsSchema: Record<string, unknown>,
  returnSchema: Record<string, unknown>,
  call: (value: unknown) => unknown,
) {
  return {
    providerDescriptor: {
      name,
      description: "test provider",
      options: [{ name: "run", description: "run", kwargsSchema, returnSchema }],
      additionalConfig: {},
    },
    setConfig: async () => undefined,
    subscribe: () => () => undefined,
    callFunctionality: vi.fn(async (_functionality: string, value: unknown) => call(value)),
  };
}

describe("dynamic provider descriptor validation at the kernel boundary", () => {
  it("routes successfully when two providers swap implementations", async () => {
    const { registerProviderFactory, kernel } = await import("../src/runtime/kernel.js");
    const schema = {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    };
    const first = provider("fake-a", schema, schema, (value) => value);
    const second = provider("fake-b", schema, schema, (value) => value);
    registerProviderFactory("fake-a", () => first);
    registerProviderFactory("fake-b", () => second);
    await kernel.setConfig([
      { name: "fake-a", activeFunctionalities: ["run"], additionalSettings: {} },
      { name: "fake-b", activeFunctionalities: ["run"], additionalSettings: {} },
    ]);
    await expect(kernel.useProvider("fake-a", "run", { value: "alpha" })).resolves.toEqual({ value: "alpha" });
    await expect(kernel.useProvider("fake-b", "run", { value: "beta" })).resolves.toEqual({ value: "beta" });
  });

  it("rejects every invalid input shape before invoking the provider", async () => {
    const { registerProviderFactory, kernel } = await import("../src/runtime/kernel.js");
    const schema = {
      type: "object",
      properties: {
        required: { type: "string" },
        scalar: { type: "number" },
        array: { type: "array", items: { type: "string" } },
        object: {
          type: "object",
          properties: { nested: { type: "boolean" } },
          required: ["nested"],
          additionalProperties: false,
        },
        choice: { enum: ["one", "two"] },
      },
      required: ["required", "scalar", "array", "object", "choice"],
      additionalProperties: false,
    };
    const fake = provider("invalid-input", schema, schema, (value) => value);
    registerProviderFactory("invalid-input", () => fake);
    await kernel.setConfig([{ name: "invalid-input", activeFunctionalities: ["run"], additionalSettings: {} }]);
    const valid = { required: "ok", scalar: 1, array: ["ok"], object: { nested: true }, choice: "one" };
    const invalid = [
      { ...valid, required: undefined },
      { ...valid, scalar: "1" },
      { ...valid, array: "no" },
      { ...valid, object: { nested: "yes" } },
      { ...valid, choice: "three" },
      { ...valid, extra: true },
      JSON.parse('{"required":"ok","scalar":1,"array":["ok"],"object":{"nested":true},"choice":"one","__proto__":{}}'),
    ];
    for (const value of invalid) await expect(kernel.useProvider("invalid-input", "run", value)).rejects.toThrow();
    const deepSchema: Record<string, unknown> = { type: "string" };
    let deepInput: unknown = "ok";
    for (let i = 0; i < 33; i++) {
      deepInput = { value: deepInput };
      Object.assign(deepSchema, { type: "object", properties: { value: { ...deepSchema } }, required: ["value"] });
    }
    await expect(kernel.useProvider("invalid-input", "run", deepInput)).rejects.toThrow();
    const manyProperties: Record<string, unknown> = {};
    const manyValues: Record<string, unknown> = {};
    for (let i = 0; i < 1025; i++) {
      manyProperties[`field${i}`] = { type: "number" };
      manyValues[`field${i}`] = i;
    }
    const fieldLimited = provider(
      "field-limited",
      { type: "object", properties: manyProperties, required: [] },
      { type: "object" },
      (value) => value,
    );
    registerProviderFactory("field-limited", () => fieldLimited);
    await kernel.setConfig([{ name: "field-limited", activeFunctionalities: ["run"], additionalSettings: {} }]);
    await expect(kernel.useProvider("field-limited", "run", manyValues)).rejects.toThrow(/bounds/);
    expect(fake.callFunctionality).not.toHaveBeenCalled();
  });

  it("rejects invalid output, including bounds and malformed schemas, before returning it", async () => {
    const { registerProviderFactory, kernel } = await import("../src/runtime/kernel.js");
    const inputSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };
    const outputSchema = {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
      additionalProperties: false,
    };
    const fake = provider("invalid-output", inputSchema, outputSchema, () => ({ result: 42 }));
    registerProviderFactory("invalid-output", () => fake);
    await kernel.setConfig([{ name: "invalid-output", activeFunctionalities: ["run"], additionalSettings: {} }]);
    await expect(kernel.useProvider("invalid-output", "run", { value: "ok" })).rejects.toThrow();
    expect(fake.callFunctionality).toHaveBeenCalledTimes(1);

    const malformed = provider(
      "malformed",
      { type: "object", properties: "invalid" },
      { type: "wat" },
      (value) => value,
    );
    registerProviderFactory("malformed", () => malformed);
    await kernel.setConfig([{ name: "malformed", activeFunctionalities: ["run"], additionalSettings: {} }]);
    await expect(kernel.useProvider("malformed", "run", {})).rejects.toThrow();
    expect(malformed.callFunctionality).not.toHaveBeenCalled();
  });
});
