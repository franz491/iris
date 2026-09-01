import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const workflow = readFileSync(new URL("../../.github/workflows/verify.yml", import.meta.url), "utf8");

test("hosted CI keeps pinned, least-privilege platform gates", () => {
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /pull_request_target|contents:\s*write|secrets\./);
  assert.match(workflow, /version: 11\.22\.0/);
  assert.match(workflow, /node-version: "22\.13\.0"/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /run: pnpm audit:policy/);
  assert.match(workflow, /jobs:\n  linux:/);
  assert.match(workflow, /platform-smoke:/);
  assert.match(workflow, /os: \[windows-latest, macos-latest\]/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /timeout-minutes: 25/);
  for (const gate of [
    "run: pnpm verify",
    "run: pnpm clean:check",
    "pnpm --filter @iris/backend typecheck",
    "pnpm --filter @iris/backend test",
    "pnpm --filter @iris/backend build",
    "pnpm --filter @iris/frontend check",
    "pnpm --filter @iris/frontend test",
    "pnpm --filter @iris/frontend build",
  ])
    assert.match(workflow, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /monorepo\/backend\/coverage/);
  assert.match(workflow, /monorepo\/frontend\/src-tauri\/target/);
});
