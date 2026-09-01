/**
 * Owns live chat instances and their in-flight construction promises.
 *
 * Size eviction is deliberately gated by the owner's idle predicate. An entry
 * is never evicted merely because it is old while it has live subscribers or
 * work in progress.
 */
export interface DisposableInstance {
  dispose(reason?: string): void;
}

export interface InstanceCacheOptions<Value> {
  maxEntries?: number;
  isIdle?: (value: Value) => boolean;
}

export class InstanceCache<Key, Value extends DisposableInstance> {
  private readonly instances = new Map<Key, Value>();
  private readonly pending = new Map<Key, Promise<Value>>();

  constructor(private readonly options: InstanceCacheOptions<Value> = {}) {}

  get size(): number {
    return this.instances.size;
  }

  async get(key: Key, create: () => Promise<Value>): Promise<Value> {
    const existing = this.instances.get(key);
    if (existing) {
      this.touch(key, existing);
      return existing;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;

    const creation = create();
    this.pending.set(key, creation);
    try {
      const value = await creation;
      // An explicit eviction/replacement while construction was pending owns
      // the result and prevents a stale instance from being installed.
      if (this.pending.get(key) === creation) {
        this.instances.set(key, value);
        this.trim(key);
      } else value.dispose("instance evicted during construction");
      return value;
    } finally {
      if (this.pending.get(key) === creation) this.pending.delete(key);
    }
  }

  set(key: Key, value: Value): void {
    this.pending.delete(key);
    const previous = this.instances.get(key);
    if (previous && previous !== value) previous.dispose("instance replaced");
    this.instances.set(key, value);
    this.trim(key);
  }

  evict(key: Key, reason = "instance evicted"): void {
    const instance = this.instances.get(key);
    this.instances.delete(key);
    this.pending.delete(key);
    instance?.dispose(reason);
  }

  /** Re-check the bound after an instance may have become idle. */
  trim(exclude?: Key): void {
    const maxEntries = this.options.maxEntries;
    const isIdle = this.options.isIdle;
    if (maxEntries === undefined || !isIdle) return;
    while (this.instances.size > maxEntries) {
      let candidate: Key | undefined;
      for (const [key, value] of this.instances) {
        if (key === exclude) continue;
        if (isIdle(value)) {
          candidate = key;
          break;
        }
      }
      if (candidate === undefined) return;
      const value = this.instances.get(candidate);
      this.instances.delete(candidate);
      value?.dispose("instance cache capacity");
    }
  }

  private touch(key: Key, value: Value): void {
    this.instances.delete(key);
    this.instances.set(key, value);
  }

  disposeAll(reason = "process shutting down"): void {
    for (const instance of this.instances.values()) instance.dispose(reason);
    this.instances.clear();
    // Pending constructors will dispose their result when they resolve.
    this.pending.clear();
  }
}
