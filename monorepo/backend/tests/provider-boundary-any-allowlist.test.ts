import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Keep this inventory narrow: it protects untrusted provider/router/API
// boundaries without banning the word “any” in explanatory comments.
const allowlist = new Set<string>();
describe("provider boundary type allowlist", () => {
  it("contains no avoidable explicit any types", () => {
    const files = ["src/providers", "src/runtime", "src/api"].flatMap((root) => {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
        );
      return walk(root);
    });
    const findings = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          /:\s*any\b|\bas\s+any\b|<any>/.test(line) && !allowlist.has(`${file}:${index + 1}`)
            ? [`${file}:${index + 1}`]
            : [],
        ),
    );
    expect(findings).toEqual([]);
  });
  it("does not let application call sites choose provider result generics", () => {
    const files = ["src/api", "src/chat", "src/providers"].flatMap((root) => {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
        );
      return walk(root);
    });
    const findings = files
      .filter((file) => !file.endsWith("runtime/kernel.ts"))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, index) => (/useProvider\s*</.test(line) ? [`${file}:${index + 1}`] : [])),
      );
    expect(findings).toEqual([]);
  });
  it("does not bypass typed contracts for built-in provider calls", () => {
    const files = ["src/api", "src/chat", "src/providers"].flatMap((root) => {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
        );
      return walk(root).filter((file) => !file.endsWith("chat/tools.ts"));
    });
    const builtIns = /useProvider\s*\(\s*["'](?:files|tts|memory|docs|audio|admin-setup|search|shell)["']/;
    const findings = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(/useProvider\s*<[^>]+>|useProvider\s*\([^)]*\)\s+as\s+/g)]
        .map((match) => `${file}:${source.slice(0, match.index).split("\n").length}`)
        .concat(builtIns.test(source) ? [`${file}:builtin-generic`] : []);
    });
    expect(findings).toEqual([]);
  });
});
