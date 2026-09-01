import { describe, expect, it, vi } from "vitest";
import { performGuestHygiene, scheduleGuestHygiene } from "../src/api/guest-hygiene.js";

describe("guest history hygiene", () => {
  it("checks metadata, then keep, then prunes in order", async () => {
    const calls: string[] = [];
    await performGuestHygiene("chat", {
      getAppMeta: async () => {
        calls.push("metadata");
        return "chat";
      },
      readKeep: () => {
        calls.push("keep");
        return 10;
      },
      pruneMessages: async (chatId, keep) => {
        calls.push(`prune:${chatId}:${keep}`);
      },
    });
    expect(calls).toEqual(["metadata", "keep", "prune:chat:10"]);
  });

  it("does not read keep or prune for another chat", async () => {
    const readKeep = vi.fn(() => 10);
    const pruneMessages = vi.fn(async () => undefined);
    await performGuestHygiene("chat", {
      getAppMeta: async () => "other",
      readKeep,
      pruneMessages,
    });
    expect(readKeep).not.toHaveBeenCalled();
    expect(pruneMessages).not.toHaveBeenCalled();
  });

  it("does not prune when keep is non-positive", async () => {
    const pruneMessages = vi.fn(async () => undefined);
    await performGuestHygiene("chat", {
      getAppMeta: async () => "chat",
      readKeep: () => 0,
      pruneMessages,
    });
    expect(pruneMessages).not.toHaveBeenCalled();
  });

  it("contains metadata, configuration, and prune failures", async () => {
    await expect(
      performGuestHygiene("chat", {
        getAppMeta: async () => {
          throw new Error("metadata failure");
        },
        readKeep: () => 10,
        pruneMessages: async () => {
          throw new Error("should not run");
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      performGuestHygiene("chat", {
        getAppMeta: async () => "chat",
        readKeep: () => {
          throw new Error("config failure");
        },
        pruneMessages: async () => {
          throw new Error("should not run");
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      performGuestHygiene("chat", {
        getAppMeta: async () => "chat",
        readKeep: () => 10,
        pruneMessages: async () => {
          throw new Error("prune failure");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("schedules without waiting for the prune operation", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pruneMessages = vi.fn(() => pending);
    scheduleGuestHygiene("chat", {
      getAppMeta: async () => "chat",
      readKeep: () => 10,
      pruneMessages,
    });
    await vi.waitFor(() => expect(pruneMessages).toHaveBeenCalledOnce());
    release();
    await pending;
  });
});
