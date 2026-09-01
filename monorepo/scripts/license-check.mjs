import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
const root = path.resolve("node_modules/.pnpm");
const allow = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "CC0-1.0", "Unlicense", "MIT-0", "MPL-2.0", "BlueOak-1.0.0", "WTFPL"]);
const deny = new Set(["GPL-3.0", "GPL-3.0-only", "AGPL-3.0", "AGPL-3.0-only"]);
export function checkLicenses(dir = root) {
  const seen = new Map(), errors = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nm = path.join(dir, entry.name, "node_modules");
    if (!existsSync(nm)) continue;
    for (const pkg of readdirSync(nm, { withFileTypes: true })) {
      const roots = pkg.name.startsWith("@") ? readdirSync(path.join(nm, pkg.name), { withFileTypes: true }).map((x) => path.join(pkg.name, x.name)) : [pkg.name];
      for (const name of roots) { try { const x = JSON.parse(readFileSync(path.join(nm, name, "package.json"), "utf8")); const l = typeof x.license === "string" ? x.license : x.license?.type; const key = `${x.name}@${x.version}`; if (!seen.has(key)) { seen.set(key, l); const ok = typeof l === "string" && !deny.has(l) && l.split(/\s+OR\s+|[()]/).filter(Boolean).some((v) => allow.has(v)); if (!ok) errors.push(`${key}: ${l ?? "missing"}`); } } catch {} }
    }
  }
  return { seen, errors };
}
if (import.meta.main) { const r = checkLicenses(); if (r.errors.length) { console.error(r.errors.join("\n")); process.exitCode = 1; } else console.log(`License check passed (${r.seen.size} packages).`); }
