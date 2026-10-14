// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeSource,
  analyzeFiles,
  analyzeMultiSource,
  preloadLibFiles,
  getLibSourceFile,
} from "../src/checker/index.js";
import { IncrementalLanguageService, IncrementalProjectLanguageService } from "../src/checker/language-service.js";
import { assertCurrentProgramSources } from "../src/frontend/program-origin.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { ts } from "../src/ts-api.js";
import { ts as originalNamespace } from "../src/frontend/typescript.js";
import { readEnv as environmentAccessor } from "../src/env.js";
import { readEnv as foundationAccessor } from "../src/shared/contracts/environment-value.js";
import { readTs5CheckerTrace as compatibilityTrace } from "../src/checker/ts5-trace.js";
import { readTs5CheckerTrace as frontendTrace } from "../src/frontend/ts5-trace.js";

const source =
  "export function run(a: number, b: number): number { const xs: number[] = [a, b]; return xs[0] + xs[1] + xs.length; }";
const policy = { backend: "linear", target: "standalone" } as const;
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const multi = () => analyzeMultiSource({ "entry.ts": source }, "entry.ts");
function check(ast: ReturnType<typeof multi>): void {
  assertCurrentProgramSources(ast.checker, ast.sourceFiles, ast.entryFile);
}
function prepare(ast: ReturnType<typeof multi>) {
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
}

describe("real Program origin and currentness", () => {
  it("authenticates each genuine constructor and the actual tracing wrapper", () => {
    expect(compatibilityTrace).toBe(frontendTrace);
    expect(ts).toBe(originalNamespace);
    expect(environmentAccessor).toBe(foundationAccessor);
    const ast = analyzeSource(source);
    assertCurrentProgramSources(ast.checker, [ast.sourceFile], ast.sourceFile);
    vi.stubEnv("JS2WASM_TRACE_TS5", "1");
    const traced = multi();
    check(traced);
    const result = prepare(traced);
    expect(result.kind).toBe("prepared");
    check(traced); // Normal bind/check caches must not invalidate unchanged syntax.
  });
  it("rejects a forged checker and a foreign wrapper before source lowering", () => {
    const ast = multi();
    expect(() => prepare({ ...ast, checker: {} as ts.TypeChecker })).toThrow(/unknown checker/);
    expect(() => prepare({ ...ast, checker: new Proxy(ast.checker, {}) })).toThrow(/unknown checker/);
  });
  it("rejects a real checker paired with a same-text foreign Program source", () => {
    const left = multi();
    const right = multi();
    expect(() => prepare({ ...right, checker: left.checker })).toThrow(/population differs/);
  });
  it("rejects omitted, duplicate, and detached entry source populations", () => {
    const ast = analyzeMultiSource({ "entry.ts": source, "other.ts": "export const n = 1;" }, "entry.ts");
    check(ast);
    expect(() => assertCurrentProgramSources(ast.checker, [ast.entryFile], ast.entryFile)).toThrow(/population/);
    expect(() => assertCurrentProgramSources(ast.checker, [ast.entryFile, ast.entryFile], ast.entryFile)).toThrow(
      /population/,
    );
    expect(() => assertCurrentProgramSources(ast.checker, ast.sourceFiles, multi().entryFile)).toThrow(/population/);
  });
  it("rejects source text drift without changing AST identity", () => {
    const ast = multi();
    Object.defineProperty(ast.entryFile, "text", { value: `${source}\n` });
    expect(() => check(ast)).toThrow(/syntax changed/);
  });
  it("rejects token drift with unchanged source text and positions", () => {
    const ast = multi();
    let number: ts.NumericLiteral | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isNumericLiteral(node)) number = node;
      ts.forEachChild(node, visit);
    };
    visit(ast.entryFile);
    expect(number).toBeDefined();
    Object.defineProperty(number!, "text", { value: "17" });
    expect(() => check(ast)).toThrow(/syntax changed/);
  });
  it("rejects a semantic declaration flag change rather than masking all NodeFlags", () => {
    const ast = multi();
    let declarations: ts.VariableDeclarationList | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclarationList(node)) declarations = node;
      ts.forEachChild(node, visit);
    };
    visit(ast.entryFile);
    expect(declarations).toBeDefined();
    Object.defineProperty(declarations!, "flags", {
      value: (declarations!.flags & ~ts.NodeFlags.Const) | ts.NodeFlags.Let,
    });
    expect(() => check(ast)).toThrow(/syntax changed/);
  });
  it("rejects a transplanted same-text syntax node", () => {
    const ast = multi();
    const foreign = multi();
    Object.defineProperty(ast.entryFile, "statements", { value: foreign.entryFile.statements });
    expect(() => check(ast)).toThrow(/syntax identity/);
  });
  it("rejects altered compiler options and authenticated checker methods", () => {
    const ast = multi();
    ast.program.getCompilerOptions().strict = false;
    expect(() => check(ast)).toThrow(/options/);
    const next = multi();
    Object.defineProperty(next.checker, "getTypeAtLocation", { value: () => undefined });
    expect(() => check(next)).toThrow(/issued method/);
  });
  it("rejects accessor syntax fields without executing them", () => {
    const ast = multi();
    const getter = vi.fn(() => ast.entryFile.statements);
    Object.defineProperty(ast.entryFile, "statements", { get: getter });
    expect(() => check(ast)).toThrow(/accessor syntax/);
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects changed real filesystem positive and negative resolution answers", () => {
    const dir = mkdtempSync(join(tmpdir(), "js2-origin-"));
    dirs.push(dir);
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, 'import { value } from "./missing"; export function run(): number { return value; }');
    const ast = analyzeFiles(entry, { skipSemanticDiagnostics: true });
    check(ast);
    writeFileSync(join(dir, "missing.ts"), "export const value = 1;");
    expect(() => check(ast)).toThrow(/host .* answer changed/);
    const next = analyzeFiles(entry, { skipSemanticDiagnostics: true });
    check(next);
    writeFileSync(entry, "export function run(): number { return 2; }");
    expect(() => check(next)).toThrow(/host .* answer changed/);
  });
  it("keeps unchanged incremental programs current and revokes source edits before reanalysis", () => {
    const service = new IncrementalLanguageService("entry.ts");
    service.updateSource(source);
    const first = service.analyze();
    const assert = () => assertCurrentProgramSources(first.checker, [first.sourceFile], first.sourceFile);
    assert();
    expect(service.analyze().program).toBe(first.program);
    assert();
    service.updateSource(`${source}\n`);
    expect(assert).toThrow(/revoked/);
    const next = service.analyze();
    assertCurrentProgramSources(next.checker, [next.sourceFile], next.sourceFile);
    service.dispose();
    expect(() => assertCurrentProgramSources(next.checker, [next.sourceFile], next.sourceFile)).toThrow(/revoked/);
  });
  it("revokes the incremental generation on options replacement", () => {
    const service = new IncrementalLanguageService("entry.ts");
    service.updateSource(source);
    const old = service.analyze();
    const next = service.analyze({ platform: "node" });
    expect(() => assertCurrentProgramSources(old.checker, [old.sourceFile], old.sourceFile)).toThrow(/revoked/);
    assertCurrentProgramSources(next.checker, [next.sourceFile], next.sourceFile);
    service.dispose();
  });
  it("revokes multi-file edits, deletion and module resolution remapping", () => {
    const service = new IncrementalProjectLanguageService();
    const files = {
      "entry.ts": 'import { n } from "pkg"; export function run(): number { return n; }',
      "a.ts": "export const n = 1;",
      "b.ts": "export const n = 2;",
    };
    service.updateProject(files, "entry.ts", { pkg: "a.ts" });
    const first = service.analyze();
    check(first);
    const resolvedFile = (ast: ReturnType<typeof multi>) => {
      const statement = ast.entryFile.statements[0];
      if (
        !ts.isImportDeclaration(statement) ||
        !statement.importClause?.namedBindings ||
        !ts.isNamedImports(statement.importClause.namedBindings)
      )
        throw new Error("fixture import missing");
      const symbol = ast.checker.getSymbolAtLocation(statement.importClause.namedBindings.elements[0]!.name)!;
      return ast.checker.getAliasedSymbol(symbol).declarations![0]!.getSourceFile().fileName;
    };
    expect(resolvedFile(first)).toMatch(/a\.ts$/);
    service.updateProject(files, "entry.ts", { pkg: "b.ts" });
    expect(() => check(first)).toThrow(/revoked/);
    const second = service.analyze();
    check(second);
    expect(resolvedFile(second)).toMatch(/b\.ts$/);
    service.updateProject({ "entry.ts": source }, "entry.ts");
    expect(() => check(second)).toThrow(/revoked/);
    const third = service.analyze();
    check(third);
    service.dispose();
    expect(() => check(third)).toThrow(/revoked/);
  });
  it("refreshes shared service library documents after actual library replacement", () => {
    const original = getLibSourceFile("lib.es5.d.ts", ts.ScriptTarget.ES2022)!.text;
    const service = new IncrementalLanguageService("entry.ts");
    service.updateSource(source);
    const old = service.analyze();
    try {
      preloadLibFiles({ "lib.es5.d.ts": `${original}\ndeclare var __originLibraryWitness: 731;` });
      expect(() => assertCurrentProgramSources(old.checker, [old.sourceFile], old.sourceFile)).toThrow(/revoked/);
      const current = service.analyze();
      assertCurrentProgramSources(current.checker, [current.sourceFile], current.sourceFile);
      expect(current.program.getSourceFiles().some((file) => file.text.includes("__originLibraryWitness"))).toBe(true);
    } finally {
      service.dispose();
      preloadLibFiles({ "lib.es5.d.ts": original });
    }
  });
  it("revokes old library origins but leaves sealed source-free codec replay independent", () => {
    const ast = multi();
    const result = prepare(ast);
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error("real preparation failed");
    const bytes = encodePreparedIrProgram(result.program);
    const service = new IncrementalLanguageService("entry.ts");
    service.updateSource(source);
    const old = service.analyze();
    preloadLibFiles({});
    expect(() => check(ast)).toThrow(/library cache/);
    expect(() => assertCurrentProgramSources(old.checker, [old.sourceFile], old.sourceFile)).toThrow(/revoked/);
    const fresh = service.analyze();
    assertCurrentProgramSources(fresh.checker, [fresh.sourceFile], fresh.sourceFile);
    expect(encodePreparedIrProgram(decodePreparedIrProgram(bytes))).toBe(bytes);
    service.dispose();
    check(multi());
  });
});
