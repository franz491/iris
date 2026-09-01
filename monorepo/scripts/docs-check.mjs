import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const roadmap = readFileSync(path.join(root, "roadmap.txt"), "utf8");
const disposition = readFileSync(path.join(root, "docs/roadmap-disposition.md"), "utf8");
const markdownFiles = [
  path.join(root, "../README.md"),
  ...["docs", "backend/docs"].flatMap((dir) => {
    const visit = (current) =>
      readdirSync(path.join(root, current), { withFileTypes: true }).flatMap((entry) => {
        const relative = path.join(current, entry.name);
        if (entry.isDirectory()) return visit(relative);
        return entry.name.endsWith(".md") ? [path.join(root, relative)] : [];
      });
    return existsSync(path.join(root, dir)) ? visit(dir) : [];
  }),
];

const numbered = [...roadmap.matchAll(/^([0-9]+)\. /gm)].map((match) => Number(match[1]));
if (new Set(numbered).size !== numbered.length) throw new Error("roadmap numbering contains duplicates");

// Parse both numbered Next items and bold Maintenance bullets from the one
// authoritative roadmap source; historical prose is intentionally ignored.
const items = [...roadmap.matchAll(/^(?:\d+\.|-)\s+\*\*([^*]+)\*\*/gm)].map((match) => match[1].trim());
for (const item of items) {
  const row = disposition.split("\n").find((line) => line.startsWith(`| ${item} `));
  if (!row) throw new Error(`roadmap item lacks disposition: ${item}`);
  const columns = row.split("|").map((value) => value.trim());
  if (!["deliver", "redesign", "defer"].includes(columns[2]))
    throw new Error(`roadmap item has invalid disposition: ${item}`);
  if (!/review \d{4}-\d{2}-\d{2}/.test(columns[3])) throw new Error(`roadmap item lacks review criterion: ${item}`);
}
const rootReadme = readFileSync(path.join(root, "../README.md"), "utf8");
if (!/not production-ready/i.test(rootReadme)) throw new Error("public README must state production-readiness limits");

const linkPattern = /\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g;
for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(linkPattern)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!existsSync(resolved)) throw new Error(`broken documentation link: ${path.relative(root, file)} -> ${target}`);
  }
}
console.log(`Documentation contract passed (${items.length} roadmap items; ${markdownFiles.length} Markdown files).`);
