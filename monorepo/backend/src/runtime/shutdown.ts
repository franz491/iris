/** Idempotent process-shutdown coordinator; resources register close/drain hooks. */
export function createShutdownCoordinator() {
  let closing = false;
  const hooks: Array<() => void | Promise<void>> = [];
  return {
    get closing() {
      return closing;
    },
    register(hook: () => void | Promise<void>) {
      if (closing) {
        void hook();
        return () => {};
      }
      hooks.push(hook);
      return () => {
        const i = hooks.indexOf(hook);
        if (i >= 0) hooks.splice(i, 1);
      };
    },
    async close() {
      if (closing) return;
      closing = true;
      // Shutdown order is part of the lifecycle contract: stop accepting new
      // work before draining dependants, while one failed hook must not block
      // later cleanup hooks.
      for (const hook of hooks.splice(0)) {
        try {
          await hook();
        } catch {
          // Best effort: continue draining all owned resources.
        }
      }
    },
  };
}

export function installSignalShutdown(
  coordinator: ReturnType<typeof createShutdownCoordinator>,
  signals: { on(signal: string, handler: () => void): void },
  listener: { close(callback?: () => void): void },
) {
  coordinator.register(() => new Promise<void>((resolve) => listener.close(resolve)));
  let installed = false;
  return () => {
    if (installed) return;
    installed = true;
    for (const signal of ["SIGTERM", "SIGINT"])
      signals.on(signal, () => {
        void coordinator.close();
      });
  };
}
