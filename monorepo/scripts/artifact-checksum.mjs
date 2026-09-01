import { createReadStream } from "node:fs";
import { lstat, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

function relativeArtifact(root, value) {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(resolvedRoot, value));
  if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error("artifact path escapes root");
  return relative.split(path.sep).join("/");
}

async function regularArtifact(root, relative) {
  const safe = relativeArtifact(root, relative);
  const stat = await lstat(path.join(root, safe));
  if (!stat.isFile()) throw new Error(`artifact is not a regular file: ${safe}`);
  return { safe, stat };
}

async function digest(file) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function createChecksumManifest(root, artifactPaths) {
  if (!Array.isArray(artifactPaths) || !artifactPaths.length) throw new Error("artifact list is empty");
  const entries = [];
  for (const artifact of artifactPaths) {
    const { safe, stat } = await regularArtifact(root, artifact);
    entries.push({ path: safe, sha256: await digest(path.join(root, safe)), size: stat.size });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error("duplicate artifact path");
  return { format: "iris-sha256-v1", root: ".", artifacts: entries };
}

export async function verifyChecksumManifest(root, manifest, expectedPaths) {
  if (!manifest || manifest.format !== "iris-sha256-v1" || manifest.root !== "." || !Array.isArray(manifest.artifacts))
    throw new Error("invalid checksum manifest");
  const expected = expectedPaths ?? manifest.artifacts.map((entry) => entry.path);
  const expectedSafe = expected.map((entry) => relativeArtifact(root, entry)).sort();
  const listed = manifest.artifacts.map((entry) => entry?.path).sort();
  if (
    listed.some((entry) => typeof entry !== "string") ||
    new Set(listed).size !== listed.length ||
    listed.join("\0") !== expectedSafe.join("\0")
  )
    throw new Error("checksum manifest artifact set mismatch");
  for (const entry of manifest.artifacts) {
    if (!/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0)
      throw new Error("invalid checksum manifest entry");
    const { safe, stat } = await regularArtifact(root, entry.path);
    if (stat.size !== entry.size || (await digest(path.join(root, safe))) !== entry.sha256)
      throw new Error(`artifact checksum mismatch: ${safe}`);
  }
  return true;
}

if (import.meta.main) {
  const [root, manifestPath, ...artifactPaths] = process.argv.slice(2);
  if (!root || !manifestPath || !artifactPaths.length)
    throw new Error("usage: artifact-checksum ROOT MANIFEST ARTIFACT...");
  const manifest = await createChecksumManifest(root, artifactPaths);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await verifyChecksumManifest(root, JSON.parse(await readFile(manifestPath, "utf8")), artifactPaths);
  console.log(`Checksum manifest verified (${manifest.artifacts.length} artifacts).`);
}
