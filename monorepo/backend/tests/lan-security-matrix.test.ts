import { describe, expect, it } from "vitest";
import { mutationOriginDecision } from "../src/api/origin-policy.js";

const LAN_HTTP = "http://192.168.1.20:5173";
const LAN_HTTPS = "https://iris.lan";
const REMOTE = "https://remote.example.test";

describe("LAN-first mutation origin matrix", () => {
  const trusted = [LAN_HTTP, LAN_HTTPS, REMOTE];

  it.each([
    ["LAN HTTP", LAN_HTTP],
    ["LAN HTTPS", LAN_HTTPS],
    ["optional remote", REMOTE],
  ])("allows configured %s origin", (_label, origin) => {
    expect(mutationOriginDecision(origin, true, trusted)).toBe("allowed");
  });

  it("rejects mismatched origins even when a session cookie is present", () => {
    expect(mutationOriginDecision("https://attacker.example", true, trusted)).toBe("untrusted_origin");
  });

  it("rejects missing Origin for cookie-authenticated mutations", () => {
    expect(mutationOriginDecision(undefined, true, trusted)).toBe("csrf_origin_required");
  });

  it("preserves LAN compatibility for non-cookie bootstrap mutations", () => {
    expect(mutationOriginDecision(undefined, false, trusted)).toBe("allowed");
  });

  it("keeps the recent-auth route policy explicit", async () => {
    const { requiresRecentAuthPath } = await import("../src/api/admin.js");
    const protectedMutations = [
      ["POST", "/users/user-id"],
      ["POST", "/users/user-id/password"],
      ["PUT", "/keys/example"],
      ["POST", "/models"],
      ["DELETE", "/models/x"],
      ["POST", "/services/x/start"],
      ["POST", "/services/x/stop"],
      ["POST", "/reset-defaults"],
    ] as const;
    for (const [method, path] of protectedMutations) expect(requiresRecentAuthPath(method, path)).toBe(true);

    // These mutate only ephemeral setup workflow state or stage a proposal;
    // approval/application is protected by the explicit paths above.
    const ordinaryMutations = [
      ["POST", "/users"],
      ["PUT", "/prompts/x"],
      ["POST", "/patches"],
      ["POST", "/setup/chat"],
      ["POST", "/setup/proposals"],
      ["POST", "/checklist/x"],
    ] as const;
    for (const [method, path] of ordinaryMutations) expect(requiresRecentAuthPath(method, path)).toBe(false);
  });
});
