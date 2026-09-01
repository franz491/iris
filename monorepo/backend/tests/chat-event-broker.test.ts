import { describe, expect, it, vi } from "vitest";
import { EventBroker } from "../src/chat/event-broker.js";

describe("chat event broker", () => {
  it("delivers to a stable subscriber snapshot during reentrant changes", () => {
    const broker = new EventBroker();
    const received: string[] = [];
    let unsubscribeSecond = () => {};
    broker.subscribe((event) => {
      received.push(`first:${event}`);
      unsubscribeSecond();
      if (event === "outer") broker.emit("inner");
    });
    unsubscribeSecond = broker.subscribe((event) => received.push(`second:${event}`));

    broker.emit("outer");

    expect(received).toEqual(["first:outer", "first:inner", "second:outer"]);
    expect(broker.size()).toBe(1);
  });

  it("isolates subscriber failures and keeps unsubscribe/clear idempotent", () => {
    const report = vi.fn();
    const broker = new EventBroker(report);
    const received: string[] = [];
    broker.subscribe(() => {
      throw new Error("subscriber failed");
    });
    const unsubscribe = broker.subscribe((event) => received.push(event));

    broker.emit("event");
    expect(received).toEqual(["event"]);
    expect(report).toHaveBeenCalledTimes(1);
    unsubscribe();
    unsubscribe();
    broker.clear();
    broker.clear();
    expect(broker.size()).toBe(0);
  });
});
