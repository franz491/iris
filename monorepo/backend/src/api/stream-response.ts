// api/stream-response.ts — utilities for streaming AI responses to the frontend.
import { increment } from "../misc/metrics.js";
export interface StreamPacket {
  event: string;
  [k: string]: unknown;
}

/** Minimal async push queue. */
export class PushQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private ended = false;
  private overflowed = false;

  constructor(private readonly maxItems = 256) {
    if (!Number.isInteger(maxItems) || maxItems < 1) throw new RangeError("maxItems must be a positive integer");
  }

  /**
   * Returns false when the queue is closed or its bounded buffer overflows.
   * Closing on overflow makes a slow/disconnected SSE consumer self-cleaning
   * instead of allowing producer traffic to grow memory without bound.
   */
  push(item: T): boolean {
    if (this.ended) return false;
    const r = this.resolvers.shift();
    if (r) r({ done: false, value: item });
    else if (this.items.length < this.maxItems) this.items.push(item);
    else {
      this.overflowed = true;
      increment("sse.queue_overflows");
      this.close();
      return false;
    }
    return true;
  }

  close(): void {
    this.ended = true;
    for (const r of this.resolvers.splice(0)) r({ done: true, value: undefined as never });
  }

  get closed(): boolean {
    return this.ended;
  }

  get didOverflow(): boolean {
    return this.overflowed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ done: false, value: this.items.shift()! });
        if (this.ended) return Promise.resolve({ done: true, value: undefined as never });
        return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
