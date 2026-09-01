export type EventSubscriber<T> = (event: T) => void;

/** Small synchronous event broker with deterministic, failure-isolated delivery. */
export class EventBroker<T> {
  private readonly subscribers = new Set<EventSubscriber<T>>();

  constructor(private readonly onSubscriberError: (error: unknown) => void = () => {}) {}

  subscribe(subscriber: EventSubscriber<T>): () => void {
    this.subscribers.add(subscriber);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.subscribers.delete(subscriber);
    };
  }

  emit(event: T): void {
    // Snapshot delivery makes subscribe/unsubscribe/reentrant emit behavior
    // deterministic and prevents mutation during iteration from skipping a
    // subscriber that was present at the start of this emission.
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch (error) {
        try {
          this.onSubscriberError(error);
        } catch {
          // Error reporting must never break delivery to other subscribers.
        }
      }
    }
  }

  clear(): void {
    this.subscribers.clear();
  }

  size(): number {
    return this.subscribers.size;
  }
}
