import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const sourceRoot = path.resolve("src");
const sourceFiles = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    return statSync(file).isDirectory() ? sourceFiles(file) : file.endsWith(".ts") ? [file] : [];
  });

describe("API module import boundaries", () => {
  it("keeps leaf production modules independent of the aggregate api router", () => {
    const violations = sourceFiles(sourceRoot)
      .map((file) => ({ file, source: readFileSync(file, "utf8") }))
      .flatMap(({ file, source }) => {
        const lines = source.split("\n");
        return lines.flatMap((line, index) =>
          /(?:from|import)\s*["'](?:\.\/|\.\.\/api\/)?api\.js["']/.test(line)
            ? [{ file: path.relative(sourceRoot, file), line: index + 1 }]
            : [],
        );
      });

    expect(violations).toEqual([]);
  });

  it("routes shared guards through the leaf module", () => {
    expect(readFileSync(path.join(sourceRoot, "api", "files.ts"), "utf8")).toContain('from "./auth-guards.js"');
    expect(readFileSync(path.join(sourceRoot, "api", "admin.ts"), "utf8")).toContain('from "./auth-guards.js"');
  });
});
