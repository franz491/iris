import { describe, expect, it } from "vitest";
import { FrontendToolConfigRegistry } from "../src/chat/frontend-tool-config-registry.js";

const tools = { fe_shell: { flavor: "frontend" }, fe_files: { flavor: "frontend" } };
const ad = (userId: string, clientId: string, promptOverrides?: Record<string, string>) => ({
  userId,
  clientId,
  updatedAt: 1,
  config: { tools: [{ tool: "fe_shell" }], promptOverrides },
});

describe("frontend tool config registry", () => {
  it("aggregates current clients with deterministic override precedence", () => {
    const registry = new FrontendToolConfigRegistry(16);
    registry.upsert(ad("z-user", "client", { fe_shell: "z" }));
    registry.upsert(ad("a-user", "client", { fe_shell: "a" }));
    const effective = registry.effectiveToolConfig({ tools: [], promptOverrides: {} }, tools);
    expect(effective.tools).toEqual([{ tool: "fe_shell" }]);
    expect(effective.promptOverrides).toEqual({ fe_shell: "z" });
  });

  it("allows replacement at capacity but rejects a new client", () => {
    const registry = new FrontendToolConfigRegistry(1);
    registry.upsert(ad("user", "one"));
    expect(() => registry.upsert(ad("user", "two"))).toThrow("capacity");
    registry.upsert(ad("user", "one", { fe_shell: "updated" }));
    expect(registry.size).toBe(1);
    expect(registry.remove("user", "one")).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("does not collide when user and client ids contain the old separator", () => {
    const registry = new FrontendToolConfigRegistry(2);
    registry.upsert(ad("user:one", "client"));
    registry.upsert(ad("user", "one:client"));
    expect(registry.size).toBe(2);
    expect(registry.remove("user:one", "client")).toBe(true);
    expect(registry.remove("user", "one:client")).toBe(true);
  });

  it("clears ownership and filters audio without its files companion", () => {
    const registry = new FrontendToolConfigRegistry();
    registry.upsert({ ...ad("user", "client"), config: { tools: [{ tool: "fe_audio" }] } });
    expect(
      registry.effectiveToolConfig({ tools: [], promptOverrides: {} }, { ...tools, fe_audio: { flavor: "frontend" } })
        .tools,
    ).toEqual([]);
    registry.clear();
    expect(registry.size).toBe(0);
  });
});
