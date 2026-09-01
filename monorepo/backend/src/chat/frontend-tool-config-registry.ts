import type { ToolConfig, ToolSetting } from "./tools.js";

export interface FrontendToolAdvertisement {
  readonly userId: string;
  readonly clientId: string;
  readonly config: ToolConfig;
  readonly updatedAt: number;
}

type KnownTool = { flavor?: string; functions?: readonly { name: string }[] };

/** Owns ephemeral frontend-tool advertisements for one live chat. */
export class FrontendToolConfigRegistry {
  private readonly entriesByClient = new Map<string, FrontendToolAdvertisement>();

  constructor(private readonly maxEntries = 256) {}

  get size(): number {
    return this.entriesByClient.size;
  }

  upsert(advertisement: FrontendToolAdvertisement): void {
    const key = this.key(advertisement.userId, advertisement.clientId);
    if (!this.entriesByClient.has(key) && this.entriesByClient.size >= this.maxEntries) {
      throw new Error("frontend tool configuration capacity exceeded");
    }
    this.entriesByClient.set(key, advertisement);
  }

  remove(userId: string, clientId: string): boolean {
    return this.entriesByClient.delete(this.key(userId, clientId));
  }

  clear(): void {
    this.entriesByClient.clear();
  }

  /** Stable snapshots prevent callers from mutating registry-owned state. */
  values(): readonly FrontendToolAdvertisement[] {
    return [...this.entriesByClient.values()].sort((a, b) =>
      this.key(a.userId, a.clientId).localeCompare(this.key(b.userId, b.clientId)),
    );
  }

  candidates(tool: string): readonly FrontendToolAdvertisement[] {
    return this.values().filter((ad) => ad.config.tools.some((setting) => setting.tool === tool));
  }

  effectiveToolConfig(base: ToolConfig, knownTools: Record<string, KnownTool>): ToolConfig {
    const merged = new Map<string, ToolSetting>(base.tools.map((setting) => [setting.tool, setting]));
    for (const ad of this.values()) {
      for (const setting of ad.config.tools) {
        if (setting.tool === "fe_audio" && !ad.config.tools.some((x) => x.tool === "fe_files")) continue;
        if (knownTools[setting.tool]?.flavor === "frontend" && !merged.has(setting.tool))
          merged.set(setting.tool, setting);
      }
    }
    return { tools: [...merged.values()], promptOverrides: this.promptOverrides(knownTools) };
  }

  loadedGroups(
    storedGroups: readonly string[],
    alwaysLoaded: readonly string[],
    knownTools: Record<string, unknown>,
  ): string[] {
    const names = [
      ...this.values().flatMap((ad) =>
        ad.config.tools
          .filter((setting) => setting.tool !== "fe_audio" || ad.config.tools.some((x) => x.tool === "fe_files"))
          .map((setting) => setting.tool),
      ),
      ...storedGroups,
      ...alwaysLoaded,
    ];
    return [...new Set(names)].filter((name) => Boolean(knownTools[name]));
  }

  promptOverrides(knownTools: Record<string, KnownTool>): Record<string, string> {
    const allowed = new Set<string>();
    for (const [name, tool] of Object.entries(knownTools)) {
      if (tool.flavor === "frontend") {
        allowed.add(name);
        for (const fn of tool.functions ?? []) allowed.add(`${name}:${fn.name}`);
      }
    }
    const result: Record<string, string> = {};
    // values() is sorted, so later entries have explicit deterministic precedence.
    for (const ad of this.values()) {
      for (const [key, value] of Object.entries(ad.config.promptOverrides ?? {})) {
        if (allowed.has(key) && typeof value === "string") result[key] = value;
      }
    }
    return result;
  }

  private key(userId: string, clientId: string): string {
    // IDs are external values and may contain the separator; encode the pair
    // structurally so distinct user/client identities cannot overwrite one
    // another in the registry.
    return JSON.stringify([userId, clientId]);
  }
}
