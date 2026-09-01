import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findGeneratedArtifacts, formatReport } from "../scripts/clean-check.mjs";

test("clean:check reports artifacts without deleting them", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "iris-clean-check-"));
  const artifactDirectory = path.join(fixture, ".next");
  const artifactFile = path.join(fixture, "src", "example.tsbuildinfo");
  await mkdir(path.dirname(artifactFile), { recursive: true });
  await mkdir(artifactDirectory);
  await writeFile(path.join(artifactDirectory, "BUILD_ID"), "fixture\n");
  await writeFile(artifactFile, "fixture build info\n");

  try {
    const artifacts = findGeneratedArtifacts(fixture);
    const output = formatReport(artifacts);

    assert.deepEqual(artifacts, [".next", "src/example.tsbuildinfo"]);
    assert.match(output, /Generated artifacts found \(nothing was deleted\)/);
    assert.match(output, /\.next/);
    assert.match(output, /src[\\/]example\.tsbuildinfo/);
    assert.equal(await readFile(path.join(artifactDirectory, "BUILD_ID"), "utf8"), "fixture\n");
    assert.equal(await readFile(artifactFile, "utf8"), "fixture build info\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("clean:check does not follow directory symlinks outside the scan root", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "iris-clean-link-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "iris-clean-outside-"));
  try {
    await mkdir(path.join(outside, "dist"));
    await writeFile(path.join(outside, "dist", "BUILD_ID"), "outside\n");
    await symlink(outside, path.join(fixture, "linked"), "junction").catch(async () => symlink(outside, path.join(fixture, "linked")));
    assert.deepEqual(findGeneratedArtifacts(fixture), []);
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("clean:check permits the coverage output owned by verify", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "iris-clean-coverage-"));
  try { await mkdir(path.join(fixture, "backend", "coverage"), { recursive: true }); assert.deepEqual(findGeneratedArtifacts(fixture), []); }
  finally { await rm(fixture, { recursive: true, force: true }); }
});

test("clean:check permits only the repository's known build outputs", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "iris-clean-allowed-"));
  try {
    await mkdir(path.join(fixture, "backend", "dist"), { recursive: true });
    await mkdir(path.join(fixture, "frontend", "dist"), { recursive: true });
    await mkdir(path.join(fixture, "unexpected", "dist"), { recursive: true });
    assert.deepEqual(findGeneratedArtifacts(fixture), ["unexpected/dist"]);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
