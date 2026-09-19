// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { ts } from "../src/frontend/typescript.js";
import { isGeneratorClosureDeclaration } from "../src/codegen/closures/generator-declaration.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const parent = "b7521221b4b7ca22f95d28671314d785815cb4f0";
const helpers = [
  "src/checker/higher-order-signature-fact.ts",
  "src/checker/signature-position.ts",
  "src/codegen/closures/generator-declaration.ts",
  "src/ir/tail-function-declarations.ts",
] as const;
const leaf = "src/frontend/type-fact-contracts.ts";
const frontend = "src/frontend/typescript.ts";
const oracle = "src/checker/oracle.ts";
const names = ["ShapeFact", "SignatureFact", "SignaturePositionPath", "TypeFact"];
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const before = (path: string) => execFileSync("git", ["show", `${parent}:${path}`], { cwd: root, encoding: "utf8" });
const parse = (path: string, source: string) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);

function declarations(source: string) {
  return parse("facts.ts", source).statements.filter(
    (node) => (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) && names.includes(node.name.text),
  );
}

function withoutFacts(source: string) {
  for (const node of [...declarations(source)].reverse()) {
    source = source.slice(0, node.getFullStart()) + source.slice(node.end);
  }
  return source;
}

function assertHelper(path: string, source: string) {
  const original = before(path)
    .replace(/(["'])(\.\.\/)+ts-api\.js\1/g, (match) => match.replace("ts-api.js", "frontend/typescript.js"))
    .replace('"./oracle.js"', '"../frontend/type-fact-contracts.js"');
  expect(source).toBe(original);
}

/** Fresh traversal of value AND type syntax; no candidate-derived allow list. */
function closure(overrides = new Map<string, string>()) {
  const allowed = new Set<string>([...helpers, leaf, frontend]);
  const visited = new Set<string>();
  const edges: string[] = [];
  function visit(path: string) {
    if (!allowed.has(path)) throw new Error(`forbidden dependency: ${path}`);
    if (visited.has(path)) return;
    visited.add(path);
    const source = parse(path, overrides.get(path) ?? read(path));
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics.length) throw new Error(`invalid syntax: ${path}`);
    function edge(specifier: ts.Node) {
      if (!ts.isStringLiteral(specifier)) throw new Error("nonliteral dependency");
      const name = specifier.text;
      if (path === frontend && name === "typescript") {
        edges.push(`${path} -> typescript`);
        return;
      }
      if (!name.startsWith(".")) throw new Error(`external dependency: ${name}`);
      const target = resolve(root, dirname(path), name).slice(root.length).replace(/^\//, "").replace(/\.js$/, ".ts");
      edges.push(`${path} -> ${target}`);
      visit(target);
    }
    function walk(node: ts.Node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
        edge(node.moduleSpecifier);
      if (ts.isImportTypeNode(node)) {
        if (!ts.isLiteralTypeNode(node.argument)) throw new Error("nonliteral dependency");
        edge(node.argument.literal);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        if (!node.moduleReference.expression) throw new Error("missing dependency");
        edge(node.moduleReference.expression);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        if (!node.arguments[0]) throw new Error("missing dependency");
        edge(node.arguments[0]);
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  for (const path of helpers) visit(path);
  return { modules: [...visited].sort(), edges: edges.sort() };
}

it.each(helpers)("preserves the complete parent implementation except the exact imports: %s", (path) => {
  assertHelper(path, read(path));
});

it.each(names)("relocates the exact recursive declaration once: %s", (name) => {
  const select = (source: string) => declarations(source).filter((node) => node.name?.getText() === name);
  const old = select(before(oracle));
  const moved = select(read(leaf));
  expect(old).toHaveLength(1);
  expect(moved).toHaveLength(1);
  expect(moved[0]!.getText()).toBe(old[0]!.getText());
  expect(select(read(oracle))).toHaveLength(0);
});

it("keeps oracle queries, annotations, caches and compatibility exports exactly", () => {
  const source = read(oracle);
  const route =
    'import type { ShapeFact, SignatureFact, SignaturePositionPath, TypeFact } from "../frontend/type-fact-contracts.js";';
  const reexport = route.replace("import type", "export type");
  expect(source.split(route)).toHaveLength(2);
  expect(source.split(reexport)).toHaveLength(2);
  expect(
    source
      .replace(route + "\n", "")
      .replace(reexport + "\n", "")
      .replace(/\n{3,}/g, "\n\n"),
  ).toBe(withoutFacts(before(oracle)).replace(/\n{3,}/g, "\n\n"));
  expect(parse(leaf, read(leaf)).statements).toHaveLength(4);
});

it("pins all six modules and seven type/value edges in the fresh frontend closure", () => {
  expect(closure()).toEqual({
    modules: [...helpers, leaf, frontend].sort(),
    edges: [
      ...helpers.map((path) => `${path} -> ${frontend}`),
      ...helpers.slice(0, 2).map((path) => `${path} -> ${leaf}`),
      `${frontend} -> typescript`,
    ].sort(),
  });
});

it.each([
  'import type { TypeFact } from "../checker/oracle.js";',
  'export type { TypeFact } from "../checker/oracle.js";',
  'type Hidden = import("../checker/oracle.js").TypeFact;',
  'import { ts } from "../ts-api.js";',
  'const hidden = import("../ts-api.js");',
])("rejects an upward leaf dependency after a valid positive: %s", (injection) => {
  expect(closure().edges).toHaveLength(7);
  expect(() => closure(new Map([[leaf, read(leaf) + "\n" + injection]]))).toThrow(/forbidden dependency/);
});

it.each([
  ["src/checker/higher-order-signature-fact.ts", "remaining: 64", "remaining: 65"],
  ["src/checker/higher-order-signature-fact.ts", "depth >= 6", "depth >= 7"],
  ["src/checker/signature-position.ts", "path.length > 12", "path.length > 13"],
  ["src/checker/signature-position.ts", "!== type", "=== type"],
  ["src/ir/tail-function-declarations.ts", "...statements.slice(0, tail)", "...statements.slice(0, tail - 1)"],
])("detects semantic drift after the exact positive: %s %s", (path, original, mutation) => {
  const source = read(path);
  assertHelper(path, source);
  expect(source.split(original)).toHaveLength(2);
  expect(() => assertHelper(path, source.replace(original, mutation))).toThrow();
});

it("uses the same static TypeScript namespace through old and new routes in a fresh process", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { ts as oldTs } from "./src/ts-api.ts";
    import { ts } from "./src/frontend/typescript.ts";
    assert.equal(oldTs, ts);
    assert.equal(oldTs.SyntaxKind, ts.SyntaxKind);
    assert.equal(oldTs.createSourceFile, ts.createSourceFile);
    console.log("static-identity-ok");
  `,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, JS2WASM_TS7: "0" } },
  );
  expect(output.trim()).toBe("static-identity-ok");
});

it("recognizes only generator expressions and methods with their original AST nodes", () => {
  const source = parse(
    "generators.ts",
    "const a = function*() {}; const b = function() {}; const o = { *g() {}, m() {} }; function* d() {}",
  );
  const accepted: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (isGeneratorClosureDeclaration(node)) accepted.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(accepted.map((node) => node.getText())).toEqual(["function*() {}", "*g() {}"]);
  expect(accepted.every((node) => node.getSourceFile() === source)).toBe(true);
});
