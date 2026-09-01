import { beforeEach, describe, expect, it } from "vitest";
import { MAX_ACTIVE_MODEL_REQUESTS, modelAdmission, resetModelAdmission } from "../src/api/model-admission.js";

describe("model request admission", () => {
  beforeEach(() => resetModelAdmission());

  it("reserves atomically per account and source and releases one slot per lease", () => {
    const leases = modelAdmission.tryAcquire(["account:a", "source:1"], MAX_ACTIVE_MODEL_REQUESTS)!;
    expect(modelAdmission.tryAcquire(["account:a"], 1)).toBeUndefined();
    leases[0].release();
    expect(modelAdmission.tryAcquire(["account:a"], 1)).toBeDefined();
    leases[1].release();
  });

  it("isolates identities and expires/reset state", () => {
    const first = modelAdmission.tryAcquire(["account:a"], MAX_ACTIVE_MODEL_REQUESTS, 1_000);
    expect(first).toBeDefined();
    expect(modelAdmission.tryAcquire(["account:b"], MAX_ACTIVE_MODEL_REQUESTS, 1_000)).toBeDefined();
    first!.forEach((lease) => lease.release());
    expect(modelAdmission.tryAcquire(["account:a"], 1, 61_000)).toBeDefined();
    resetModelAdmission();
    expect(modelAdmission.tryAcquire(["account:a"], MAX_ACTIVE_MODEL_REQUESTS)).toBeDefined();
  });

  it("does not expire active leases during a long generation", () => {
    const leases = modelAdmission.tryAcquire(["account:a"], MAX_ACTIVE_MODEL_REQUESTS, 1_000)!;
    expect(modelAdmission.tryAcquire(["account:a"], 1, 61_000)).toBeUndefined();
    leases.forEach((lease) => lease.release());
    expect(modelAdmission.tryAcquire(["account:a"], 1, 61_001)).toBeDefined();
  });
});
