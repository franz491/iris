import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

test("documentation hierarchy and roadmap disposition contract passes", () => {
  const result = spawnSync(process.execPath, [path.resolve("scripts/docs-check.mjs")], {
    encoding: "utf8",
    cwd: path.resolve("."),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
