import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generateSbom, validateSbom } from "../scripts/sbom.mjs";

test("SBOM contains deterministic npm and Cargo identities with licenses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "iris-sbom-"));
  try {
    await mkdir(path.join(root, "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg"), { recursive: true });
    await writeFile(
      path.join(root, "node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/package.json"),
      JSON.stringify({ name: "pkg", version: "1.0.0", license: "MIT" }),
    );
    const lock = path.join(root, "Cargo.lock");
    await writeFile(lock, 'version = 4\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n');
    const first = validateSbom(generateSbom({ nodeStore: path.join(root, "node_modules/.pnpm"), cargoLock: lock }));
    const second = generateSbom({ nodeStore: path.join(root, "node_modules/.pnpm"), cargoLock: lock });
    assert.deepEqual(first, second);
    assert.match(first.documentNamespace, /[0-9a-f]{64}$/);
    assert.deepEqual(
      first.packages.map((p) => [p.name, p.versionInfo, p.licenseConcluded]),
      [
        ["serde", "1.0.0", "NOASSERTION"],
        ["pkg", "1.0.0", "MIT"],
      ],
    );
    for (const pkg of first.packages) {
      assert.equal(pkg.downloadLocation, "NOASSERTION");
      assert.equal(pkg.filesAnalyzed, false);
      assert.equal(pkg.copyrightText, "NOASSERTION");
      assert.ok(
        pkg.externalRefs.some((ref) => ref.referenceCategory === "PACKAGE-MANAGER" && ref.referenceType === "purl"),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SBOM validation rejects missing package identity fields", () => {
  assert.throws(
    () => validateSbom({ spdxVersion: "SPDX-2.3", packages: [{ name: "x", versionInfo: "1" }] }),
    /invalid SBOM package identity/,
  );
});
