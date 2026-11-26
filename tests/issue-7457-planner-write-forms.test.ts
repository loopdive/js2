// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7457 — the call planner decides whether a function binding is written from the binding-write index (#7455), not
// from its own scanner. One program per write form: a written binding is not resolved to the function's cached
// funcref; an unwritten one, or one whose same-named local is written, still is. (`function f(){} var f = 6;` is
// #7480: the checker gives the declarator its own symbol, so neither analysis sees that write.)
import { describe, expect, it } from "vitest";
import { makeIrImportedFunctionResolver } from "../src/ir/imported-functions.js";
import { ts } from "../src/ts-api.js";

function program(files: Record<string, string>) {
  const host: ts.CompilerHost = {
    fileExists: (name) => name in files,
    readFile: (name) => files[name],
    getSourceFile: (name, languageVersion) =>
      name in files ? ts.createSourceFile(name, files[name]!, languageVersion, true, ts.ScriptKind.TS) : undefined,
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    directoryExists: (directoryName) => directoryName === "/repo",
    realpath: (path) => path,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const names = Object.keys(files);
  const built = ts.createProgram(names, { noLib: true, strict: false, target: ts.ScriptTarget.ES2022 }, host);
  const sourceFiles = names.map((name) => built.getSourceFile(name)!);
  return { sourceFiles, resolver: makeIrImportedFunctionResolver(built.getTypeChecker(), sourceFiles) };
}

/** The last call `f(...)` in `file`, resolved as a same-file function value or an import. */
function resolvesCall(files: Record<string, string>, file = "/repo/entry.ts"): boolean {
  const { sourceFiles, resolver } = program(files);
  let callee: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "f")
      callee = node.expression;
    ts.forEachChild(node, visit);
  };
  visit(sourceFiles.find((source) => source.fileName === file)!);
  return (resolver.resolveTopLevelFunctionValue(callee!) ?? resolver.resolveImportedFunction(callee!)) !== undefined;
}

const entry = (body: string) => ({ "/repo/entry.ts": `function f(): number { return 1; }\n${body}\nf();` });

describe("#7457 the call planner reads function-binding writes from the shared index", () => {
  it("resolves a function binding that is never written", () => {
    expect(resolvesCall(entry(""))).toBe(true);
  });

  it.each([
    ["a plain assignment", "f = undefined as any;"],
    ["a compound assignment", "(f as any) += 1;"],
    ["an update", "(f as any)++;"],
    ["a destructuring target", "[f] = [undefined as any];"],
    ["a destructuring target with a default", "[f = undefined as any] = [];"],
    ["a shorthand target", "({ f } = { f: undefined as any });"],
    ["a for-in head", "for (f in {} as any) {}"],
  ])("refuses a binding written by %s", (_form, body) => {
    expect(resolvesCall(entry(body))).toBe(false);
  });

  it("does not count a destructuring default's expression as a write of what it reads", () => {
    expect(resolvesCall(entry("let x; [x = f] = [];"))).toBe(true);
  });

  it("does not count a write of a same-named local", () => {
    expect(resolvesCall(entry("function g() { let f = 1; f = 2; return f; }"))).toBe(true);
  });

  it("refuses an imported function whose exporting module writes it", () => {
    const files = {
      "/repo/lib.ts": "export function f(): number { return 1; }\nexport function reset() { (f as any) = undefined; }",
      "/repo/entry.ts": 'import { f } from "./lib";\nf();',
    };
    expect(resolvesCall(files)).toBe(false);
    expect(resolvesCall({ ...files, "/repo/lib.ts": "export function f(): number { return 1; }" })).toBe(true);
  });
});
