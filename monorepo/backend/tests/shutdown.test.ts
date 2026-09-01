import { describe, expect, it } from "vitest";
import { createShutdownCoordinator, installSignalShutdown } from "../src/runtime/shutdown.js";

describe("shutdown coordinator", () => {
  it("closes registered resources once and tolerates hook failures", async () => {
    const coordinator = createShutdownCoordinator();
    const calls: string[] = [];
    coordinator.register(() => {
      calls.push("sse");
    });
    coordinator.register(async () => {
      calls.push("db");
      throw new Error("already closed");
    });
    await Promise.all([coordinator.close(), coordinator.close()]);
    expect(calls.sort()).toEqual(["db", "sse"]);
    expect(coordinator.closing).toBe(true);
  });
  it("installs idempotent signal handlers that close the listener", async () => {
    const coordinator = createShutdownCoordinator();
    const handlers = new Map<string, () => void>();
    let closes = 0;
    const listener = {
      close(done: () => void) {
        closes++;
        done();
      },
    };
    const install = installSignalShutdown(
      coordinator,
      {
        on(signal: string, handler: () => void) {
          handlers.set(signal, handler);
        },
      },
      listener,
    );
    install();
    install();
    handlers.get("SIGTERM")!();
    handlers.get("SIGINT")!();
    await new Promise((resolve) => setImmediate(resolve));
    expect(closes).toBe(1);
  });
  it("runs hooks in registration order while continuing after failures", async () => {
    const coordinator = createShutdownCoordinator();
    const calls: string[] = [];
    coordinator.register(async () => {
      calls.push("listener");
      await Promise.resolve();
    });
    coordinator.register(() => {
      calls.push("sse");
      throw new Error("closed");
    });
    coordinator.register(() => {
      calls.push("database");
    });
    await coordinator.close();
    expect(calls).toEqual(["listener", "sse", "database"]);
  });
});
