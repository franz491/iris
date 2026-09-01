import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { checkLicenses } from "../scripts/license-check.mjs";

test("license scanner handles canonical scoped roots, duplicates, and policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "iris-license-"));
  const pkg = async (name, version, license, nested = false) => {
    const base = path.join(root, "store", "node_modules", ...name.split("/"));
    await mkdir(base, { recursive: true });
    await writeFile(path.join(base, "package.json"), JSON.stringify({ name, version, license }));
    if (nested) { await mkdir(path.join(base, "fixtures", "node_modules", "bad"), { recursive: true }); await writeFile(path.join(base, "fixtures", "node_modules", "bad", "package.json"), JSON.stringify({ name: "bad", version: "1", license: "GPL-3.0" })); }
  };
  try {
    await pkg("plain", "1", "MIT"); await pkg("@scope/tool", "1", "MIT OR Apache-2.0"); await pkg("dup", "1", "MIT"); await pkg("dup", "1", "MIT", true);
    const result = checkLicenses(root);
    assert.equal(result.errors.length, 0);
    assert.equal(result.seen.size, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("license scanner rejects missing, unknown, GPL, and AGPL licenses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "iris-license-deny-"));
  try {
    for (const [name, license] of [["missing", undefined], ["unknown", "Proprietary"], ["gpl", "GPL-3.0"], ["agpl", "AGPL-3.0"]]) {
      const dir = path.join(root, name, "node_modules", name); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, "package.json"), JSON.stringify({ name, version: "1", ...(license ? { license } : {}) }));
    }
    assert.equal(checkLicenses(root).errors.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
