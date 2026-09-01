import { beforeEach, describe, expect, it } from "vitest";
import {
  GUEST_CHAT_ACCESS_LIMIT_PER_WINDOW,
  GUEST_CHAT_MESSAGE_LIMIT_PER_WINDOW,
  guestChatLimiter,
  guestChatRateLimitResponse,
  resetGuestChatLimiter,
} from "../src/api/guest-chat-limiter.js";

beforeEach(resetGuestChatLimiter);

describe("guest chat limiter", () => {
  it("expires access and message windows independently", () => {
    for (let i = 0; i < GUEST_CHAT_ACCESS_LIMIT_PER_WINDOW; i++)
      expect(guestChatLimiter.consume("access:source:x", GUEST_CHAT_ACCESS_LIMIT_PER_WINDOW, 1000 + i)).toBeUndefined();
    expect(guestChatLimiter.consume("access:source:x", GUEST_CHAT_ACCESS_LIMIT_PER_WINDOW, 2000)).toBe(59);
    for (let i = 0; i < GUEST_CHAT_MESSAGE_LIMIT_PER_WINDOW; i++)
      expect(
        guestChatLimiter.consume("message:source:x", GUEST_CHAT_MESSAGE_LIMIT_PER_WINDOW, 1000 + i),
      ).toBeUndefined();
    expect(guestChatLimiter.consume("message:source:x", GUEST_CHAT_MESSAGE_LIMIT_PER_WINDOW, 61_001)).toBeUndefined();
  });

  it("returns a non-cacheable retry response", async () => {
    const response = guestChatRateLimitResponse(4);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("4");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "rate_limited",
      message: "Too many guest chat requests; try again later.",
    });
  });
});
