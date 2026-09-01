import { probeBackend } from "./backend-probe";

export type BackendStatus = "starting" | "ready" | "offline" | "reconnecting";

/** Connect-only readiness coordinator. It never starts or stops a backend. */
export class BackendLifecycle {
  status: BackendStatus = "starting";
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async probe(url: string): Promise<boolean> {
    const generation = ++this.generation;
    this.status = this.status === "ready" ? "reconnecting" : "starting";
    const online = await probeBackend(this.fetchImpl, url, 4000);
    if (generation !== this.generation) return false;
    this.status = online ? "ready" : "offline";
    return online;
  }

  retry(url: string): void {
    this.cancel();
    this.status = "reconnecting";
    this.timer = setTimeout(() => void this.probe(url), 1000);
  }

  cancel(): void {
    this.generation += 1;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
