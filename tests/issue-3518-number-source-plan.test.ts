// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/frontend/typescript.js";
import {
  analyzeMultiSource,
  getLibSourceFile,
  isCurrentCompilerLibrarySourceFile,
  preloadLibFiles,
} from "../src/checker/index.js";
import { prepareNumberConversionResolver } from "../src/frontend/builtins/prepare-number-conversion.js";
function plan(source: string, extra: Record<string, string> = {}) {
  const ast = analyzeMultiSource({ "./entry.ts": source, ...extra }, "./entry.ts");
  const declaration = ast.entryFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error("missing source function");
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(declaration);
  expect(calls.length).toBeGreaterThan(0);
  return { ast, calls, resolver: prepareNumberConversionResolver(ast.checker, ast.sourceFiles, declaration) };
}
describe("source-authenticated Number call plan", () => {
  it("retains zero, one and extra positional arguments", () => {
    const p = plan("export function run() {Number(); Number(1); return Number(1, 2, 3);}");
    expect(p.calls.map(p.resolver.preparedNumberCall)).toEqual([true, true, true]);
  });
  it("accepts actual module-initializer statements and rejects cloned populations", () => {
    const source = "export const n = Number(7);";
    const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
    const statement = ast.entryFile.statements[0];
    if (!statement || !ts.isVariableStatement(statement)) throw new Error("missing module initializer");
    const call = statement.declarationList.declarations[0]?.initializer;
    if (!call || !ts.isCallExpression(call)) throw new Error("missing Number call");
    const resolver = prepareNumberConversionResolver(ast.checker, ast.sourceFiles, [statement]);
    expect(resolver.preparedNumberCall(call)).toBe(true);
    const cloned = ts.createSourceFile(ast.entryFile.fileName, source, ts.ScriptTarget.Latest, true);
    const cloneResolver = prepareNumberConversionResolver(ast.checker, ast.sourceFiles, [...cloned.statements]);
    expect(cloneResolver.preparedNumberCall(call)).toBe(false);
    const clonedStatement = cloned.statements[0];
    if (!clonedStatement || !ts.isVariableStatement(clonedStatement)) throw new Error("missing cloned statement");
    const clonedCall = clonedStatement.declarationList.declarations[0]?.initializer;
    if (!clonedCall || !ts.isCallExpression(clonedCall)) throw new Error("missing cloned call");
    expect(cloneResolver.preparedNumberCall(clonedCall)).toBe(false);
    expect(resolver.preparedNumberCall(clonedCall)).toBe(false);
  });
  it("refuses cloned calls with identical text", () => {
    const p = plan("export function run() {return Number(1);}");
    expect(p.resolver.preparedNumberCall(p.calls[0]!)).toBe(true);
    const other = ts.createSourceFile("entry.ts", "Number(1)", ts.ScriptTarget.Latest, true);
    const statement = other.statements[0];
    if (!statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
      throw new Error("bad clone");
    expect(p.resolver.preparedNumberCall(statement.expression)).toBe(false);
  });
  it.each([
    "export function run(Number: (x:number)=>number) {return Number(1);}",
    "export function run() {const Number = (x:number)=>x; return Number(1);}",
    "const alias = Number; export function run() {return alias(1);}",
    "export function run() {return Number?.(1);}",
    "export function run() {return Number(...[1]);}",
    "export function run() {return Number<number>(1);}",
    "Number = ((x:any)=>7) as any; export function run() {return Number(1);}",
    "globalThis.Number = ((x:any)=>7) as any; export function run() {return Number(1);}",
    "globalThis['Number'] = ((x:any)=>7) as any; export function run() {return Number(1);}",
    "const g = globalThis; g.Number = ((x:any)=>7) as any; export function run() {return Number(1);}",
  ])("refuses unsupported or mutated binding: %s", (source) => {
    const p = plan(source);
    expect(p.calls.every((call) => !p.resolver.preparedNumberCall(call))).toBe(true);
  });
  it("refuses imported user ambient Number", () => {
    const p = plan('import {Number} from "./foreign"; export function run(){return Number(1);}', {
      "./foreign.d.ts": "export declare function Number(x:number): number;",
    });
    expect(p.calls.map(p.resolver.preparedNumberCall)).toEqual([false]);
  });
  it("refuses user ambient declarations merged into the global Number symbol", () => {
    const p = plan("export function run(){return Number(1);}", {
      "./foreign.d.ts": "declare var Number: NumberConstructor;",
    });
    expect(p.calls.map(p.resolver.preparedNumberCall)).toEqual([false]);
  });
  it("observes a write in another supplied source", () => {
    const p = plan('import "./writer"; export function run(){return Number(1);}', {
      "./writer.ts": "Number = ((x:any) => 9) as any;",
    });
    expect(p.calls.map(p.resolver.preparedNumberCall)).toEqual([false]);
  });
  it("does not grant authority to a forged library filename", () => {
    const original = getLibSourceFile("lib.d.ts", ts.ScriptTarget.Latest);
    if (!original) throw new Error("missing compiler library");
    expect(isCurrentCompilerLibrarySourceFile(original)).toBe(true);
    expect(
      isCurrentCompilerLibrarySourceFile(
        ts.createSourceFile(original.fileName, original.text, ts.ScriptTarget.Latest, true),
      ),
    ).toBe(false);
  });
  it("revokes cached identity when preloading replaces a library", () => {
    const p = plan("export function run(){return Number(1);}");
    expect(p.resolver.preparedNumberCall(p.calls[0]!)).toBe(true);
    // Empty preload still invalidates the derived composite library nodes.
    preloadLibFiles({});
    expect(p.resolver.preparedNumberCall(p.calls[0]!)).toBe(false);
  });
});
