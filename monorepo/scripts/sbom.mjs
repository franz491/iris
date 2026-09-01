import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const root = path.resolve(".");

function packageRoots(store) {
  if (!existsSync(store)) return [];
  const result = [];
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const modules = path.join(store, entry.name, "node_modules");
    if (!existsSync(modules)) continue;
    for (const pkg of readdirSync(modules, { withFileTypes: true })) {
      if (pkg.name.startsWith("@")) {
        const scope = path.join(modules, pkg.name);
        if (existsSync(scope))
          for (const child of readdirSync(scope, { withFileTypes: true }))
            if (child.isDirectory()) result.push(path.join(scope, child.name));
      } else if (pkg.isDirectory()) result.push(path.join(modules, pkg.name));
    }
  }
  return result;
}

function nodeComponents(store) {
  const seen = new Map();
  for (const dir of packageRoots(store)) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (typeof pkg.name !== "string" || typeof pkg.version !== "string") continue;
      const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
      seen.set(`npm:${pkg.name}@${pkg.version}`, {
        name: pkg.name,
        versionInfo: pkg.version,
        licenseConcluded: license || "NOASSERTION",
        licenseDeclared: license || "NOASSERTION",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        copyrightText: "NOASSERTION",
        purl: `pkg:npm/${pkg.name}@${pkg.version}`,
      });
    } catch {}
  }
  return [...seen.values()];
}

function cargoComponents(lockfile) {
  if (!existsSync(lockfile)) return [];
  const text = readFileSync(lockfile, "utf8");
  const seen = new Map();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!name || !version) continue;
    seen.set(`cargo:${name}@${version}`, {
      name,
      versionInfo: version,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      copyrightText: "NOASSERTION",
      purl: `pkg:cargo/${name}@${version}`,
    });
  }
  return [...seen.values()];
}

export function generateSbom({
  nodeStore = path.join(root, "node_modules/.pnpm"),
  cargoLock = path.join(root, "frontend/src-tauri/Cargo.lock"),
} = {}) {
  const components = [...nodeComponents(nodeStore), ...cargoComponents(cargoLock)].sort((a, b) =>
    `${a.purl}`.localeCompare(b.purl),
  );
  const digest = crypto.createHash("sha256").update(JSON.stringify(components)).digest("hex");
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "iris-dependencies",
    documentNamespace: `https://iris.local/sbom/${digest}`,
    creationInfo: { created: "1970-01-01T00:00:00Z", creators: ["Tool: iris-sbom"] },
    packages: components.map(({ purl, ...x }, i) => ({
      SPDXID: `SPDXRef-Package-${i + 1}`,
      ...x,
      externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: purl }],
    })),
  };
}

export function validateSbom(sbom) {
  if (!sbom || sbom.spdxVersion !== "SPDX-2.3" || !Array.isArray(sbom.packages) || !sbom.packages.length)
    throw new Error("invalid SBOM document");
  for (const pkg of sbom.packages) {
    if (
      typeof pkg.name !== "string" ||
      !pkg.name ||
      typeof pkg.versionInfo !== "string" ||
      !pkg.versionInfo ||
      typeof pkg.downloadLocation !== "string" ||
      typeof pkg.licenseConcluded !== "string" ||
      !pkg.licenseConcluded ||
      typeof pkg.licenseDeclared !== "string" ||
      !pkg.licenseDeclared ||
      pkg.filesAnalyzed !== false ||
      typeof pkg.copyrightText !== "string" ||
      !pkg.copyrightText ||
      !Array.isArray(pkg.externalRefs) ||
      !pkg.externalRefs.some(
        (ref) =>
          ref.referenceCategory === "PACKAGE-MANAGER" &&
          ref.referenceType === "purl" &&
          typeof ref.referenceLocator === "string",
      )
    )
      throw new Error("invalid SBOM package identity");
  }
  return sbom;
}

if (import.meta.main) {
  const out = path.join(os.tmpdir(), `iris-sbom-${process.pid}.json`);
  const sbom = validateSbom(generateSbom());
  try {
    writeFileSync(out, JSON.stringify(sbom));
    validateSbom(JSON.parse(readFileSync(out, "utf8")));
    console.log(`SBOM check passed (${sbom.packages.length} packages; serialized and removed temporary output).`);
  } finally {
    unlinkSync(out);
  }
}
