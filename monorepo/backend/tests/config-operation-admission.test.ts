import { beforeEach, describe, expect, it } from "vitest";
import {
  configOperationKeys,
  resetConfigOperationAdmission,
  tryConfigOperationAdmission,
} from "../src/api/config-operation-admission.js";

describe("configuration operation admission", () => {
  beforeEach(resetConfigOperationAdmission);
  it("serializes one account/source operation and releases idempotently", () => {
    const request = new Request("http://iris.test");
    const release = tryConfigOperationAdmission(configOperationKeys(request, "admin"))!;
    expect(tryConfigOperationAdmission(["account:admin"])).toBeUndefined();
    release();
    release();
    expect(tryConfigOperationAdmission(["account:admin"])).toBeDefined();
  });
  it("does not trust forwarded source headers", () => {
    const request = new Request("http://iris.test", { headers: { "x-forwarded-for": "spoof" } });
    expect(configOperationKeys(request, "admin")).toEqual(["account:admin"]);
  });
});
