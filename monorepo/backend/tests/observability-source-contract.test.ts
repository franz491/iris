import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
const root = path.resolve("src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

const isNamedCall = (node: ts.Node, names: Set<string>): boolean =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && names.has(node.expression.text);

const isBootstrapWarning = (file: string, method: string, node: ts.CallExpression): boolean => {
  if (path.basename(file) !== "index.ts" || method !== "warn" || node.arguments.length !== 1) return false;
  const argument = node.arguments[0];
  if (ts.isIdentifier(argument)) return argument.text === "token";
  if (!ts.isStringLiteral(argument)) return false;
  return (
    argument.text === "Iris is not configured. Open /admin and enter this one-use bootstrap token:" ||
    argument.text === "The token expires in 1 hour. Use an SSH tunnel or HTTPS when bootstrapping across a network."
  );
};

const sourceViolations = (file: string, source: string): number[] => {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const loggerNames = new Set<string>();
  const violations: number[] = [];
  const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callee = node.initializer.expression;
      if (ts.isIdentifier(callee) && /logger|makeLogger/.test(callee.text) && ts.isIdentifier(node.name))
        loggerNames.add(node.name.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = node.expression.expression;
      const method = node.expression.name.text;
      if (ts.isIdentifier(receiver) && loggerNames.has(receiver.text) && /^(info|warn|error|debug)$/.test(method)) {
        const bootstrap = isBootstrapWarning(file, method, node);
        const argument = node.arguments[0];
        const envelope =
          argument &&
          ts.isCallExpression(argument) &&
          ts.isPropertyAccessExpression(argument.expression) &&
          ts.isIdentifier(argument.expression.expression) &&
          argument.expression.expression.text === "JSON" &&
          argument.expression.name.text === "stringify" &&
          argument.arguments.length === 1 &&
          ts.isCallExpression(argument.arguments[0]) &&
          ts.isIdentifier(argument.arguments[0].expression) &&
          /^(eventRecord|errorEvent|accessLogRecord)$/.test(argument.arguments[0].expression.text);
        if (!bootstrap && !envelope) violations.push(line(node));
        if (!bootstrap && envelope) {
          const record = argument.arguments[0];
          const kind = ts.isIdentifier(record.expression) ? record.expression.text : "";
          const expected =
            method === "error" ? "error" : method === "warn" ? "warn" : method === "debug" ? "debug" : "info";
          if (kind === "eventRecord") {
            const levelArg = record.arguments[3];
            const level = levelArg && ts.isStringLiteral(levelArg) ? levelArg.text : "info";
            if (level !== expected) violations.push(line(node));
          } else if (kind === "errorEvent" && method !== "error") violations.push(line(node));
        }
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Error") {
      const text = node.arguments?.map((a) => a.getText(tree)).join(" ") ?? "";
      if (/\b(?:res|response)\.(?:text|body)\b/.test(text)) violations.push(line(node));
    }
    ts.forEachChild(node, walk);
  };
  walk(tree);
  return violations;
};
describe("observability source contract", () => {
  it("rejects unsafe raw error logger interpolation outside the allowlist", () => {
    const violations: string[] = [];
    for (const file of files(root)) {
      const source = readFileSync(file, "utf8");
      for (const line of sourceViolations(file, source)) violations.push(`${path.relative(root, file)}:${line}`);
    }
    expect(violations).toEqual([]);
  });
  it("keeps console output confined to intentional CLI/bootstrap surfaces", () => {
    const violations: string[] = [];
    for (const file of files(root)) {
      const source = readFileSync(file, "utf8");
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const walk = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "console" &&
          /^(log|warn|error)$/.test(node.expression.name.text) &&
          !/(^cli\.ts$|^cli\/|^misc\/logging\.ts$)/.test(path.relative(root, file))
        )
          violations.push(
            `${path.relative(root, file)}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`,
          );
        ts.forEachChild(node, walk);
      };
      walk(tree);
    }
    expect(violations).toEqual([]);
  });
  it("keeps detector rules strict for interpolation and unsafe payload patterns", () => {
    const unsafe = [
      'log.error("failed", error);',
      "log.warn(`failed ${value}`);",
      "log.error(response.text);",
      "log.error(JSON.stringify(unknownValue));",
      `log.info(
  "completion response",
  { body: response.body, context: request.context, thought: result.thought },
);`,
      "console.log(`new ${secret}`);",
    ];
    const safe = ['log.error("failed", code);', 'console.log("bootstrap token required");'];
    const pattern =
      /\blog\.(info|debug|error|warn)\s*\(([\s\S]*?)(\b(error|unknown)\b|\.message|response\.(text|body)|JSON\.stringify\(|\b(request|body|context|content|thought|baseUrl)\b|`[^`]*\$\{)/;
    expect(unsafe.slice(0, 4).map((line) => pattern.test(line))).toEqual([true, true, true, true]);
    expect(pattern.test(unsafe[4])).toBe(true);
    expect(
      /(?:throw\s+new\s+Error|new\s+Error)\s*\([^)]*(?:res|response)\.(?:text|body)[^)]*\)/.test(
        "throw new Error(`upstream ${await res.text()}`);",
      ),
    ).toBe(true);
    expect(safe.every((line) => !pattern.test(line))).toBe(true);
    expect(/\bconsole\.(log|warn|error)\s*\(/.test(unsafe[5])).toBe(true);
    const envelope = /log\.(info|warn|error|debug)\s*\([\s\S]*?(eventRecord|errorEvent)\(/;
    expect(envelope.test("log.info('fixed text');")).toBe(false);
    expect(envelope.test("log.warn(\n  'fixed text',\n);")).toBe(false);
  });
});
