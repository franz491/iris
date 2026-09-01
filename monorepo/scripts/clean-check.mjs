import { readdirSync } from "node:fs";
import path from "node:path";

const root = process.env.CLEAN_CHECK_ROOT || process.cwd();
const generatedDirectories = new Set([
  ".cache",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "out",
  "storybook-static",
  "target",
]);
const ignoredDirectories = new Set([".git", "node_modules"]);
const allowedBuildOutputs = new Set(["backend/dist", "frontend/dist", "frontend/src-tauri/target"]);
function scan(directory, root, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (generatedDirectories.has(entry.name) && !(entry.name === "coverage" && path.relative(root, fullPath) === "backend/coverage")) {
        const relative = path.relative(root, fullPath);
        if (!allowedBuildOutputs.has(relative)) found.push(relative);
      } else {
        scan(fullPath, root, found);
      }
    } else if (entry.isFile() && entry.name.endsWith(".tsbuildinfo")) {
      found.push(path.relative(root, fullPath));
    }
  }
}

export function findGeneratedArtifacts(scanRoot = root) {
  const artifacts = [];
  scan(scanRoot, scanRoot, artifacts);
  return artifacts.sort();
}

export function formatReport(artifacts) {
  if (artifacts.length) {
    return [
      "Generated artifacts found (nothing was deleted):",
      ...artifacts.map((item) => `  ${item}`),
    ].join("\n");
  }
  return "Clean-output check passed: no common generated artifacts found.";
}

if (import.meta.main) {
  const artifacts = findGeneratedArtifacts();
  if (artifacts.length) {
    console.error(formatReport(artifacts));
    process.exitCode = 1;
  } else {
    console.log(formatReport(artifacts));
  }
}
