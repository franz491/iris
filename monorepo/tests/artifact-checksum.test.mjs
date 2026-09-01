import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createChecksumManifest, verifyChecksumManifest } from "../scripts/artifact-checksum.mjs";

test("checksum manifests are sorted, streamed, and detect tamper/missing/extra artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "iris-artifacts-"));
  try {
    await writeFile(path.join(root, "z.bin"), "z");
    await writeFile(path.join(root, "a.bin"), "a");
    const manifest = await createChecksumManifest(root, ["z.bin", "a.bin"]);
    assert.deepEqual(
      manifest.artifacts.map((entry) => entry.path),
      ["a.bin", "z.bin"],
    );
    assert.equal(await verifyChecksumManifest(root, manifest, ["a.bin", "z.bin"]), true);
    await writeFile(path.join(root, "z.bin"), "tampered");
    await assert.rejects(() => verifyChecksumManifest(root, manifest, ["a.bin", "z.bin"]), /checksum mismatch/);
    await writeFile(path.join(root, "z.bin"), "z");
    await assert.rejects(() => verifyChecksumManifest(root, manifest, ["a.bin", "z.bin", "extra.bin"]), /artifact set/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checksum manifests reject symlinks and paths escaping the explicit root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "iris-artifacts-safe-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "iris-artifacts-outside-"));
  try {
    await writeFile(path.join(outside, "secret"), "secret");
    await symlink(path.join(outside, "secret"), path.join(root, "link"));
    await assert.rejects(() => createChecksumManifest(root, ["link"]), /regular file/);
    await assert.rejects(() => createChecksumManifest(root, ["../secret"]), /escapes root/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
