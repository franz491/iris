import { beforeEach, describe, expect, it } from "vitest";
import {
  credentialKeys,
  CredentialAdmission,
  resetCredentialAdmission,
  tryCredentialAdmission,
} from "../src/api/credential-admission.js";

describe("credential mutation admission", () => {
  beforeEach(() => resetCredentialAdmission());
  it("enforces atomic account/source capacity and idempotent release", () => {
    const first = tryCredentialAdmission(["account:a", "source:1"])!;
    const second = tryCredentialAdmission(["account:a", "source:1"])!;
    expect(tryCredentialAdmission(["account:a", "source:1"])).toBeUndefined();
    first();
    first();
    expect(tryCredentialAdmission(["account:a"])).toBeDefined();
    second();
  });
  it("uses only the adapter source seam", () => {
    const request = new Request("http://iris.test", { headers: { "x-forwarded-for": "spoof" } });
    expect(credentialKeys(request, "user")).toEqual(["account:user"]);
  });
  it("does not classify malformed sign-ins as bootstrap work", () => {
    const request = new Request("http://iris.test");
    expect(credentialKeys(request, undefined, false)).toEqual([]);
    expect(credentialKeys(request)).toEqual(["bootstrap"]);
  });
  it("rejects new keys at the configured capacity without evicting active leases", () => {
    const bounded = new CredentialAdmission(3);
    const leases: Array<() => void> = [];
    for (let i = 0; i < 3; i++) {
      const release = bounded.tryAcquire([`active:${i}`]);
      expect(release).toBeDefined();
      leases.push(release!);
    }
    expect(bounded.tryAcquire(["overflow"])).toBeUndefined();
    leases.forEach((release) => release());
  });
});
