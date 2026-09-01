import { describe, expect, it, vi } from "vitest";
import { withRecentAuth } from "../src/lib/reauth-coordinator";

const recent = () => Object.assign(new Error("recent"), { code: "recent_auth_required" });
describe("recent auth coordinator", () => {
  it("prompts and retries exactly once", async () => {
    const op = vi.fn().mockRejectedValueOnce(recent()).mockResolvedValue("ok");
    await expect(withRecentAuth(op, vi.fn().mockResolvedValue(true))).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(2);
  });
  it("does not retry after cancel or ordinary errors", async () => {
    const op = vi.fn().mockRejectedValue(recent());
    await expect(withRecentAuth(op, vi.fn().mockResolvedValue(false))).rejects.toThrow("recent");
    expect(op).toHaveBeenCalledTimes(1);
    const ordinary = vi.fn().mockRejectedValue(new Error("bad"));
    await expect(withRecentAuth(ordinary, vi.fn())).rejects.toThrow("bad");
    expect(ordinary).toHaveBeenCalledTimes(1);
  });
});
