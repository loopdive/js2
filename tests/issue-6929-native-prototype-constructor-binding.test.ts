// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import { compile, createIncrementalCompiler } from "../src/index.js";
import type { CompileOptions, CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";
import { IncrementalLanguageService } from "../src/checker/language-service.js";
import { binderFor } from "../src/checker/binder.js";
import {
  createTypeOracle,
  DifferentialOracle,
  DivergenceLedger,
  globalDivergenceLedger,
} from "../src/checker/oracle-backend.js";
import type { BindingDeclarationEvidence } from "../src/checker/oracle.js";
import { recoverAmbientPrototypeConstructorBinding } from "../src/codegen/expressions/non-constructable.js";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConstructorOriginalInputs,
  runConstructorOriginalInputControls,
} from "./helpers/issue-6929/constructor-original-inputs.js";

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const ORIGINALS: Readonly<Record<string, string>> = {
  "proxy-non-callable-throws.js": "0dff80adb5e19b3231f426aa4d4b1cd052dadc6555b019e3ca274c67d6969447",
  "proxy-bound-function.js": "362bfcb98de66a6be13f7198afcb1bae9433dbfaa478bede7e0d90fe2d7eaa74",
  "proxy-function-expression.js": "9070c6be3d3d25a1e6e37e4d10bd83edf374ed9681529ab28f4139847c56ced9",
  "proxy-generator-function.js": "2c33314f9c4f567d49d1f66183531a9cb6696cab1583eb091795db34598c2142",
  "proxy-arrow-function.js": "edf647e1538d6ccc6291b4f69954d0b21b1a0e13466746336387f8674c3b9a3b",
  "proxy-method-definition.js": "16ee1af4fea6da30f21c07ad10ac9f59b685401170f3e69047070ef885a0cfc8",
  "GeneratorFunction.js": "fc07757e1e4d74147c01366dab2a9b2496cd65422b31463892515532798a6d5a",
  "proxy-class.js": "85f6829f92b0a37cca0e01024047e1c1ac3a5b04e543260178fdab28039efe9b",
  "not-a-constructor.js": "52c3c2aa9b4557c99712505a914eb32b8026c087349dc453bec288e5302b91f2",
};
function directory(id: string): string {
  const scratch = join(WORKSPACE, ".tmp");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, `6929-constructor-regression-${id.replaceAll(/[^a-zA-Z0-9-]/g, "-")}-`));
}

const QUERY_CASES = [
  {
    id: "original-style-captured-variable",
    source: "var toString = Function.prototype.toString; function inspect() { new toString(); }",
    recovered: true,
  },
  {
    id: "parenthesized-initializer",
    source: "var toString = (Function.prototype.toString); function inspect() { new toString(); }",
    recovered: true,
  },
  {
    id: "binding-write-remains-runtime",
    source:
      "var toString = Function.prototype.toString; toString = function () {}; function inspect() { new toString(); }",
    recovered: true,
  },
  {
    id: "captured-write-remains-runtime",
    source:
      "var toString = Function.prototype.toString; function write() { toString = function () {}; } function inspect() { new toString(); }",
    recovered: true,
  },
  {
    id: "argument-write-remains-runtime",
    source:
      "var toString = Function.prototype.toString; function inspect() { new toString(toString = function () {}); }",
    recovered: true,
  },
  {
    id: "real-checker-variable-refusal",
    source: "var ordinaryAlias = Function.prototype.toString; new ordinaryAlias();",
    recovered: false,
  },
  { id: "source-function-refusal", source: "function toString() {} new toString();", recovered: false },
  { id: "source-class-refusal", source: "class toString {} new toString();", recovered: false },
  { id: "parameter-refusal", source: "function inspect(toString) { new toString(); }", recovered: false },
  {
    id: "nested-let-refusal",
    source:
      "var toString = Function.prototype.toString; function inspect() { let toString = function () {}; new toString(); }",
    recovered: false,
  },
  {
    id: "nested-const-refusal",
    source:
      "var toString = Function.prototype.toString; function inspect() { const toString = function () {}; new toString(); }",
    recovered: false,
  },
  {
    id: "sibling-scope-refusal",
    source: "{ let toString = Function.prototype.toString; } { let toString = function () {}; new toString(); }",
    recovered: false,
  },
  {
    id: "shadowed-root-refusal",
    source:
      "var Function = { prototype: { toString: function () {} } }; var toString = Function.prototype.toString; new toString();",
    recovered: false,
  },
  {
    id: "duplicate-var-refusal",
    source: "var toString = Function.prototype.toString; var toString; new toString();",
    recovered: false,
  },
  { id: "destructuring-refusal", source: "var { toString } = Function.prototype; new toString();", recovered: false },
  { id: "unresolved-refusal", source: "new missingConstructor();", recovered: false },
  {
    id: "with-refusal",
    source: "var toString = Function.prototype.toString; with ({}) { new toString(); }",
    recovered: false,
  },
  {
    id: "direct-eval-refusal",
    source: "var toString = Function.prototype.toString; eval('toString = function () {}'); new toString();",
    recovered: false,
  },
  {
    id: "parenthesized-direct-eval-refusal",
    source: "var toString = Function.prototype.toString; (eval)('toString = function () {}'); new toString();",
    recovered: false,
  },
  {
    id: "nested-parenthesized-direct-eval-refusal",
    source: "var toString = Function.prototype.toString; ((eval))('toString = function () {}'); new toString();",
    recovered: false,
  },
  {
    id: "member-eval-not-direct",
    source: "var toString = Function.prototype.toString; eval.call(null, '1'); new toString();",
    recovered: true,
  },
  {
    id: "comma-eval-not-direct",
    source: "var toString = Function.prototype.toString; (0, eval)('1'); new toString();",
    recovered: true,
  },
  {
    id: "optional-eval-not-direct",
    source: "var toString = Function.prototype.toString; eval?.('1'); new toString();",
    recovered: true,
  },
  { id: "import-refusal", source: "import { toString } from './foreign.js'; new toString();", recovered: false },
  {
    id: "export-refusal",
    source: "export var toString = Function.prototype.toString; new toString();",
    recovered: false,
  },
  {
    id: "alias-graph-refusal",
    source: "var prior = Function.prototype.toString; var toString = prior; new toString();",
    recovered: false,
  },
  {
    id: "annex-b-refusal",
    source: "var toString = Function.prototype.toString; if (true) { function toString() {} } new toString();",
    recovered: false,
  },
] as const;
function uniqueNew(source: ts.SourceFile): ts.NewExpression {
  const nodes: ts.NewExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (nodes.length !== 1) throw new Error(`UNKNOWN original query site population: ${nodes.length}`);
  return nodes[0]!;
}

const STRICT_EVIDENCE_CASES = [
  { id: "resolved-source", source: QUERY_CASES[5].source, kind: "resolved", ambient: false },
  { id: "resolved-ambient", source: QUERY_CASES[0].source, kind: "resolved", ambient: true },
  { id: "authoritative-absence", source: QUERY_CASES[15].source, kind: "absent", ambient: undefined },
] as const;
const STRICT_ORACLE_REGISTRATIONS = 13;
function withBindingAst<T>(
  source: string,
  inspect: (ast: ReturnType<IncrementalLanguageService["analyze"]>) => T,
  fileName = "binding.js",
): T {
  const service = new IncrementalLanguageService(fileName);
  try {
    service.updateSource(source, fileName);
    const ast = service.analyze({ allowJs: true, skipSemanticDiagnostics: true });
    expect(ast.syntacticDiagnostics).toEqual([]);
    return inspect(ast);
  } finally {
    service.dispose();
  }
}
function originalCallee(source: ts.SourceFile): ts.Identifier {
  const callee = uniqueNew(source).expression;
  if (!ts.isIdentifier(callee)) throw new Error("UNKNOWN strict evidence identifier");
  expect(callee.getSourceFile()).toBe(source);
  return callee;
}
function prototypeRoot(source: ts.SourceFile): ts.Identifier {
  const statement = source.statements[0];
  if (!statement || !ts.isVariableStatement(statement)) throw new Error("UNKNOWN original variable statement");
  const initializer = statement.declarationList.declarations[0]?.initializer;
  if (!initializer || !ts.isPropertyAccessExpression(initializer)) throw new Error("UNKNOWN original member");
  const prototype = initializer.expression;
  if (!ts.isPropertyAccessExpression(prototype) || !ts.isIdentifier(prototype.expression)) {
    throw new Error("UNKNOWN original prototype root");
  }
  expect(prototype.expression.getSourceFile()).toBe(source);
  return prototype.expression;
}
function observeSymbolQueries<T>(
  checker: ts.TypeChecker,
  operation: () => T,
  fault?: { node: ts.Node; sentinel: Error },
): { value: T; queries: { node: ts.Node; symbol: ts.Symbol | undefined }[] } {
  const original = checker.getSymbolAtLocation;
  const queries: { node: ts.Node; symbol: ts.Symbol | undefined }[] = [];
  const observer = vi.spyOn(checker, "getSymbolAtLocation").mockImplementation((node) => {
    const symbol = original.call(checker, node);
    queries.push({ node, symbol });
    if (fault && node === fault.node) throw fault.sentinel;
    return symbol;
  });
  try {
    return { value: operation(), queries };
  } finally {
    observer.mockRestore();
    expect(checker.getSymbolAtLocation).toBe(original);
  }
}
function evidenceRecord(evidence: BindingDeclarationEvidence): object {
  if (evidence.kind !== "resolved") return { kind: evidence.kind };
  const declaration = (node: ts.Declaration): object => ({
    fileName: node.getSourceFile().fileName,
    ambient: node.getSourceFile().isDeclarationFile,
    kind: node.kind,
    pos: node.pos,
    end: node.end,
  });
  return {
    kind: evidence.kind,
    declarations: evidence.declarations.map(declaration),
    valueDeclaration: evidence.valueDeclaration ? declaration(evidence.valueDeclaration) : null,
  };
}
function strictReceipt(id: string, facts: object): void {
  const receipt = {
    id,
    sourceQueryControl: true,
    canonicalVerdicts: 0,
    absentCalleePositiveRecoveryCoverage: "UNKNOWN; no genuine missing-symbol recovered binding observed",
    ...facts,
  };
  writeFileSync(join(directory(`strict-oracle-${id}`), "query.json"), JSON.stringify(receipt, null, 2));
  console.info("6929-constructor-strict-oracle", JSON.stringify(receipt));
}

const PRELUDE = `var trace = 0; var calls = 0;
function typeErrorFrom(thunk) { try { thunk(); return -1; } catch (error) {
return error instanceof TypeError && error.constructor === TypeError ? 11 : -2; } }
function Own(value) { calls++; this.value = value; }
function first() { trace = trace * 10 + 1; return 41; }
function second() { trace = trace * 10 + 2; return 42; }
function third() { trace = trace * 10 + 3; return 43; }
var sentinel = { marker: 99 };`;
interface BodyCase {
  readonly id: string;
  readonly setup?: string;
  readonly body: string;
  readonly expected: number;
}
const BODY_CASES: readonly BodyCase[] = [
  {
    id: "captured-original-spelling",
    setup: "var toString = Function.prototype.toString;",
    body: "return typeErrorFrom(function () { new toString(); });",
    expected: 11,
  },
  {
    id: "parenthesized-alias",
    setup: "var toString = (Function.prototype.toString);",
    body: "return typeErrorFrom(function () { new (toString)(); });",
    expected: 11,
  },
  {
    id: "differently-spelled-alias",
    setup: "var methodAlias = Function.prototype.toString;",
    body: "return typeErrorFrom(function () { new methodAlias(); });",
    expected: 11,
  },
  {
    id: "direct-member",
    body: "return typeErrorFrom(function () { new Function.prototype.toString(); });",
    expected: 11,
  },
  {
    id: "computed-member",
    body: 'return typeErrorFrom(function () { new Function.prototype["toString"](); });',
    expected: 11,
  },
  {
    id: "after-reflect-materialization",
    setup: "var toString = Function.prototype.toString;",
    body: "var reflected = typeErrorFrom(function () { Reflect.construct(Own, [], toString); }); var made = typeErrorFrom(function () { new toString(); }); return reflected * 100 + made;",
    expected: 1111,
  },
  {
    id: "after-descriptor-materialization",
    setup:
      'var descriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString"); var toString = Function.prototype.toString;',
    body: "return typeErrorFrom(function () { new toString(); });",
    expected: 11,
  },
  {
    id: "native-method-remains-callable",
    setup: "var toString = Function.prototype.toString;",
    body: 'return typeof toString.call(Own) === "string" ? 17 : -1;',
    expected: 17,
  },
  {
    id: "native-arrow-nonconstructor",
    setup: "var arrow = () => 1;",
    body: "return typeErrorFrom(function () { new arrow(); });",
    expected: 11,
  },
  {
    id: "native-generator-nonconstructor",
    setup: "var generator = function* () { yield 1; };",
    body: "return typeErrorFrom(function () { new generator(); });",
    expected: 11,
  },
  {
    id: "native-method-nonconstructor",
    setup: "var method = { m() {} }.m;",
    body: "return typeErrorFrom(function () { new method(); });",
    expected: 11,
  },
  {
    id: "accessor-function-nonconstructor",
    setup: 'var accessor = Object.getOwnPropertyDescriptor({ get p() { return 1; } }, "p").get;',
    body: "return typeErrorFrom(function () { new accessor(); });",
    expected: 11,
  },
  {
    id: "arguments-once-in-order",
    setup: "var toString = Function.prototype.toString;",
    body: "var result = typeErrorFrom(function () { new toString(first(), second(), third()); }); return trace * 100 + result;",
    expected: 12311,
  },
  {
    id: "first-argument-abrupt",
    setup: "var toString = Function.prototype.toString; function boom() { trace = 1; throw sentinel; }",
    body: "try { new toString(boom(), second()); return -1; } catch (error) { return error === sentinel ? trace * 100 + 13 : -2; }",
    expected: 113,
  },
  {
    id: "second-argument-abrupt",
    setup: "var toString = Function.prototype.toString; function boom() { trace = trace * 10 + 2; throw sentinel; }",
    body: "try { new toString(first(), boom(), third()); return -1; } catch (error) { return error === sentinel ? trace * 100 + 13 : -2; }",
    expected: 1213,
  },
  {
    id: "runtime-spread-order",
    setup:
      "var toString = Function.prototype.toString; function build() { return [first(), second(), third()]; } function construct(values) { return new toString(...values); }",
    body: "var result = typeErrorFrom(function () { construct(build()); }); return trace * 100 + result;",
    expected: 12311,
  },
  {
    id: "runtime-spread-getters",
    setup:
      'var toString = Function.prototype.toString; var values = []; Object.defineProperty(values, "0", { get: first }); Object.defineProperty(values, "1", { get: second }); values.length = 2; function construct(input) { return new toString(...input); }',
    body: "var result = typeErrorFrom(function () { construct(values); }); return trace * 100 + result;",
    expected: 1211,
  },
  {
    id: "reassigned-before-use",
    setup: "var toString = Function.prototype.toString; toString = Own;",
    body: "var made = new toString(41); return made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "captured-setter-write",
    setup: "var toString = Function.prototype.toString; function replace() { toString = Own; }",
    body: "replace(); var made = new toString(41); return made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "argument-time-reassignment-old-callee",
    setup: "var toString = Function.prototype.toString; function replace() { toString = Own; return 41; }",
    body: "var prior = typeErrorFrom(function () { new toString(replace()); }); var made = new toString(41); return prior === 11 && made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "argument-time-reassignment-constructor-callee",
    setup:
      "var toString = Function.prototype.toString; toString = Own; function replace() { toString = Function.prototype.toString; return 41; }",
    body: "var made = new toString(replace()); return made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "prototype-overwrite-before-capture",
    setup: "Function.prototype.toString = Own; var toString = Function.prototype.toString;",
    body: "var made = new toString(41); return made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "prototype-overwrite-after-capture",
    setup: "var toString = Function.prototype.toString; Function.prototype.toString = Own;",
    body: "return typeErrorFrom(function () { new toString(); });",
    expected: 11,
  },
  {
    id: "prototype-getter-before-capture",
    setup:
      'Object.defineProperty(Function.prototype, "toString", { configurable: true, get: function () { trace++; return Own; } }); var toString = Function.prototype.toString;',
    body: "var made = new toString(41); return trace === 1 && made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "throwing-prototype-getter",
    setup:
      'Object.defineProperty(Function.prototype, "toString", { configurable: true, get: function () { trace++; throw sentinel; } });',
    body: "try { var toString = Function.prototype.toString; new toString(); return -1; } catch (error) { return error === sentinel && trace === 1 ? 13 : -2; }",
    expected: 13,
  },
  {
    id: "escaped-through-object-then-written",
    setup:
      "var toString = Function.prototype.toString; var holder = { current: toString }; function update() { toString = Own; }",
    body: "update(); var made = new toString(41); return holder.current !== toString && made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "escaped-through-call-then-written",
    setup:
      "var toString = Function.prototype.toString; var held; function receive(value) { held = value; } receive(toString); toString = Own;",
    body: "var made = new toString(41); return held !== toString && made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "source-function-shadow",
    setup: "function toString(value) { this.value = value; }",
    body: "var made = new toString(41); return made instanceof toString && made.value === 41 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "source-class-shadow",
    setup: "class toString { constructor(value) { this.value = value; } }",
    body: "var made = new toString(41); return made instanceof toString && made.value === 41 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "parameter-shadow",
    setup: "function construct(toString) { return new toString(41); }",
    body: "var made = construct(Own); return made instanceof Own && made.value === 41 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "nested-let-shadow",
    setup: "var toString = Function.prototype.toString;",
    body: "let toString = Own; var made = new toString(41); return made instanceof Own && made.value === 41 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "nested-const-shadow",
    setup: "var toString = Function.prototype.toString;",
    body: "const toString = Own; var made = new toString(41); return made instanceof Own && made.value === 41 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "sibling-binding-shadows",
    setup: "var toString = Function.prototype.toString;",
    body: "{ let toString = Own; var made = new toString(41); if (!(made instanceof Own) || made.value !== 41) return -1; } { const toString = Own; var next = new toString(42); return next instanceof Own && next.value === 42 ? 42 : -2; }",
    expected: 42,
  },
  {
    id: "shadowed-intrinsic-root",
    setup: "var Function = { prototype: { toString: Own } }; var toString = Function.prototype.toString;",
    body: "var made = new toString(41); return made instanceof Own && made.value === 41 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "duplicate-variable",
    setup: "var toString = Function.prototype.toString; var toString = Own;",
    body: "var made = new toString(41); return made instanceof Own && made.value === 41 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "destructuring-binding",
    setup: "var { toString } = { toString: Own };",
    body: "var made = new toString(41); return made instanceof Own && made.value === 41 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "unresolved-identifier",
    body: "try { new missingConstructor(); return -1; } catch (error) { return error instanceof ReferenceError && error.constructor === ReferenceError ? 13 : -2; }",
    expected: 13,
  },
  {
    id: "ordinary-constructor",
    body: "var made = new Own(first()); return made instanceof Own && made.value === 41 && calls === 1 && trace === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "class-constructor",
    setup: "class ClassCtor { constructor(value) { calls++; this.value = value; } }",
    body: "var made = new ClassCtor(first()); return made instanceof ClassCtor && made.value === 41 && calls === 1 && trace === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "bound-constructor",
    setup: "var Bound = Own.bind(null, 41);",
    body: "var made = new Bound(); return made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "proxy-constructor",
    setup: "var Wrapped = new Proxy(Own, {});",
    body: "var made = new Wrapped(41); return made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "bound-native-nonconstructor",
    setup: "var Bound = Function.prototype.toString.bind(Own);",
    body: "return typeErrorFrom(function () { new Bound(); });",
    expected: 11,
  },
  {
    id: "proxy-native-nonconstructor",
    setup: "var Wrapped = new Proxy(Function.prototype.toString, {});",
    body: "return typeErrorFrom(function () { new Wrapped(); });",
    expected: 11,
  },
  {
    id: "proxy-literal-handler-extraction",
    setup:
      "var ProxyAlias = Proxy; var Wrapped = new ProxyAlias(Own, { construct: function (target, values) { trace++; return { value: values[0] + 1 }; } });",
    body: "var made = new Wrapped(41); return made.value === 42 && calls === 0 && trace === 1 ? 42 : -1;",
    expected: 42,
  },
  {
    id: "function-intrinsic-extraction",
    setup: "var FunctionAlias = Function;",
    body: 'var made = new FunctionAlias("value", "return value + 1;"); return made(41);',
    expected: 42,
  },
  {
    id: "typed-array-extraction",
    setup: "var Constructor = Int8Array;",
    body: "var made = new Constructor(2); made[0] = 41; return made.length === 2 && made[0] === 41 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "ordinary-runtime-spread-extraction",
    setup: "function construct(Ctor, values) { return new Ctor(...values); }",
    body: "var made = construct(Own, [first()]); return made instanceof Own && made.value === 41 && calls === 1 && trace === 1 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "callee-getter-before-arguments",
    setup: "var holder = { get current() { trace = trace * 10 + 4; return Own; } };",
    body: "var made = new holder.current(first()); return made instanceof Own && made.value === 41 && calls === 1 && trace === 41 ? 41 : -1;",
    expected: 41,
  },
  {
    id: "callee-getter-abrupt-before-arguments",
    setup: "var holder = { get current() { trace = 4; throw sentinel; } };",
    body: "try { new holder.current(first()); return -1; } catch (error) { return error === sentinel && trace === 4 && calls === 0 ? 13 : -2; }",
    expected: 13,
  },
  {
    id: "direct-eval-refusal-runtime-control",
    setup: "var toString = Function.prototype.toString;",
    body: 'eval("toString = Own"); var made = new toString(41); return made instanceof Own && made.value === 41 && calls === 1 ? 41 : -1;',
    expected: 41,
  },
];

const BASE: CompileOptions = {
  fileName: "constructor.js",
  allowJs: true,
  target: "standalone",
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
};
const PROFILES: Readonly<Record<string, CompileOptions>> = {
  standalone: BASE,
  wasi: { ...BASE, target: "wasi" },
  host: { ...BASE, target: "gc" },
  "native-first-host": { ...BASE, target: "gc", semanticProviders: "native-first" },
};
interface Specimen {
  readonly id: string;
  readonly source: string;
  readonly expected: number;
  readonly options: CompileOptions;
}
const SPECIMENS = BODY_CASES.flatMap((row) =>
  Object.entries(PROFILES).map(
    ([profile, options]): Specimen => ({
      id: `${profile}/${row.id}`,
      source: `${PRELUDE}\n${row.setup ?? ""}\nexport function main() { ${row.body} }`,
      expected: row.expected,
      options,
    }),
  ),
);

interface Observation {
  readonly side: "one-shot" | "incremental";
  outcome:
    | "compile-threw"
    | "malformed"
    | "compile-error"
    | "missing-binary"
    | "invalid-binary"
    | "wasm-threw"
    | "missing-main"
    | "wrong-type"
    | "returned";
  stage: "compile" | "validate" | "instantiate" | "init" | "main" | "returned";
  compileVisited: boolean;
  instantiateVisited: boolean;
  initCalls: number;
  mainCalls: number;
  errors?: CompileResult["errors"];
  binarySha256?: string;
  imports?: WebAssembly.ModuleImportDescriptor[];
  value?: number;
  raw?: { kind: string; display: string };
  error?: string;
  hostPrototypeRestored?: boolean;
  hostPrototypeRestoreError?: string;
}
async function observe(
  specimen: Specimen,
  side: Observation["side"],
  capture: string,
  compileSide: () => Promise<CompileResult>,
): Promise<Observation> {
  const target = join(capture, side);
  mkdirSync(target);
  const row: Observation = {
    side,
    outcome: "compile-threw",
    stage: "compile",
    compileVisited: false,
    instantiateVisited: false,
    initCalls: 0,
    mainCalls: 0,
  };
  writeFileSync(join(target, specimen.options.fileName?.endsWith(".ts") ? "source.ts" : "source.js"), specimen.source);
  writeFileSync(join(target, "options.json"), JSON.stringify(specimen.options, null, 2));
  let hostDescriptor: PropertyDescriptor | undefined;
  try {
    row.compileVisited = true;
    const result = await compileSide();
    if (!result || typeof result.success !== "boolean" || !Array.isArray(result.errors)) {
      row.outcome = "malformed";
      return row;
    }
    row.errors = result.errors;
    writeFileSync(join(target, "errors.json"), JSON.stringify(result.errors, null, 2));
    if (!result.success) {
      row.outcome = "compile-error";
      return row;
    }
    if (!(result.binary instanceof Uint8Array) || result.binary.length === 0) {
      row.outcome = "missing-binary";
      return row;
    }
    const binary = new Uint8Array(result.binary);
    row.binarySha256 = digest(binary);
    writeFileSync(join(target, "normal.wasm"), binary);
    row.stage = "validate";
    if (!WebAssembly.validate(binary)) {
      row.outcome = "invalid-binary";
      return row;
    }
    row.imports = WebAssembly.Module.imports(new WebAssembly.Module(binary));
    const runtime = specimen.options.target === "gc" ? buildCompiledImports(result) : undefined;
    // Preserve the runtime's installed facade, but isolate specimen mutations
    // of the actual host intrinsic between both APIs and subsequent rows.
    if (runtime) hostDescriptor = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
    const imports: WebAssembly.Imports = runtime
      ? {
          env: runtime.env,
          "wasm:js-string": runtime["wasm:js-string"],
          string_constants: runtime.string_constants,
          string_constants16: runtime.string_constants16,
        }
      : {};
    row.stage = "instantiate";
    row.instantiateVisited = true;
    const { instance } = await WebAssembly.instantiate(binary, imports);
    runtime?.setInstance?.(instance);
    if (typeof instance.exports.__module_init === "function") {
      row.stage = "init";
      row.initCalls++;
      instance.exports.__module_init();
    }
    if (typeof instance.exports.main !== "function") {
      row.outcome = "missing-main";
      return row;
    }
    row.stage = "main";
    row.mainCalls++;
    const value: unknown = instance.exports.main();
    row.raw = { kind: typeof value, display: String(value) };
    if (typeof value !== "number" || !Number.isFinite(value)) {
      row.outcome = "wrong-type";
      return row;
    }
    row.value = value;
    row.outcome = "returned";
    row.stage = "returned";
  } catch (error) {
    row.outcome = row.stage === "compile" ? "compile-threw" : "wasm-threw";
    row.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  } finally {
    if (hostDescriptor) {
      try {
        Object.defineProperty(Function.prototype, "toString", hostDescriptor);
        const restored = Object.getOwnPropertyDescriptor(Function.prototype, "toString");
        row.hostPrototypeRestored =
          restored !== undefined &&
          restored.value === hostDescriptor.value &&
          restored.get === hostDescriptor.get &&
          restored.set === hostDescriptor.set &&
          restored.writable === hostDescriptor.writable &&
          restored.enumerable === hostDescriptor.enumerable &&
          restored.configurable === hostDescriptor.configurable;
      } catch (error) {
        row.hostPrototypeRestoreError = String(error);
      }
    }
    writeFileSync(join(target, "observation.json"), JSON.stringify(row, null, 2));
  }
  return row;
}
async function pair(specimen: Specimen, reused?: ReturnType<typeof createIncrementalCompiler>) {
  const capture = directory(specimen.id);
  const sourcePaths = [
    "src/codegen/expressions/non-constructable.ts",
    "src/codegen/expressions/new-super.ts",
    "src/codegen/expressions/builtin-native-dyn-construct.ts",
    "src/checker/binder.ts",
    "src/checker/oracle.ts",
    "src/checker/inhouse-oracle.ts",
    "src/checker/oracle-backend.ts",
  ];
  const provenance = {
    base: "dbf5b4f74b37d67e525b2af36fd1fe49803b1348",
    semanticComparisonBase: "7d9e8ce3c6efcd4ebcfca6e14e8f895a69e9ae18",
    id: specimen.id,
    sourceSha256: digest(specimen.source),
    options: specimen.options,
    sourceSeals: Object.fromEntries(sourcePaths.map((path) => [path, digest(readFileSync(join(WORKSPACE, path)))])),
    fixtureSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    plannedCompiles: 2,
    plannedInstantiateVisits: 2,
    canonicalVerdicts: 0,
    environment: Object.fromEntries(
      [
        "JS2WASM_NUMERIC_LOCALS",
        "JS2WASM_NUMERIC_RETURNS",
        "JS2WASM_NUMERIC_FIELDS",
        "JS2WASM_UNION_ANY_REP",
        "JS2WASM_ORACLE_BACKEND",
      ].map((name) => [name, process.env[name] ?? null]),
    ),
  };
  writeFileSync(join(capture, "provenance.json"), JSON.stringify(provenance, null, 2));
  const oneShot = await observe(specimen, "one-shot", capture, () => compile(specimen.source, specimen.options));
  let service = reused;
  let disposalError: string | undefined;
  const incremental = await observe(specimen, "incremental", capture, () => {
    service ??= createIncrementalCompiler();
    return service.compile(specimen.source, specimen.options);
  });
  if (!reused)
    try {
      service?.dispose();
    } catch (error) {
      disposalError = String(error);
    }
  const observations = [oneShot, incremental];
  const counts = {
    compileVisited: observations.filter((row) => row.compileVisited).length,
    instantiateVisited: observations.filter((row) => row.instantiateVisited).length,
    mainCalls: observations.reduce((sum, row) => sum + row.mainCalls, 0),
    initCalls: observations.reduce((sum, row) => sum + row.initCalls, 0),
    returned: observations.filter((row) => row.outcome === "returned").length,
    errors: observations.filter((row) => row.outcome !== "returned").length,
    wasmThrows: observations.filter((row) => row.outcome === "wasm-threw").length,
    disposalErrors: disposalError === undefined ? 0 : 1,
  };
  const receipt = { provenance, oneShot, incremental, counts, disposalError };
  writeFileSync(join(capture, "pair.json"), JSON.stringify(receipt, null, 2));
  console.info("6929-constructor-pair", JSON.stringify(receipt));
  return { specimen, receipt, capture };
}
function assertPair(record: Awaited<ReturnType<typeof pair>>): void {
  const { specimen, receipt } = record;
  expect(receipt.disposalError).toBeUndefined();
  expect(receipt.counts.compileVisited).toBe(2);
  expect(receipt.counts.instantiateVisited).toBe(2);
  expect(receipt.counts.mainCalls).toBe(2);
  expect(receipt.counts.returned).toBe(2);
  expect(receipt.provenance.sourceSeals["src/checker/binder.ts"]).toBe(
    "e495c71bd7cd26ef36a32f3a504193552a78aa30c61a3deedc77def931bd0c3e",
  );
  for (const row of [receipt.oneShot, receipt.incremental]) {
    expect(row.outcome, JSON.stringify(row)).toBe("returned");
    expect(row.errors).toEqual([]);
    expect(row.value).toBe(specimen.expected);
    expect(row.initCalls).toBeLessThanOrEqual(1);
    expect(row.hostPrototypeRestoreError).toBeUndefined();
    if (specimen.options.target === "gc") expect(row.hostPrototypeRestored).toBe(true);
    if (specimen.options.target !== "gc") expect(row.imports).toEqual([]);
  }
}

describe("issue 6929 runtime construction of recovered native-prototype bindings", () => {
  it.each(QUERY_CASES)("identity query: $id", (row) => {
    const service = new IncrementalLanguageService("binding.js");
    try {
      service.updateSource(row.source, "binding.js");
      const ast = service.analyze({ allowJs: true, skipSemanticDiagnostics: true });
      const callee = uniqueNew(ast.sourceFile).expression;
      const found = recoverAmbientPrototypeConstructorBinding(
        { oracle: createTypeOracle(ast.checker, "checker") },
        callee,
      );
      const binder = binderFor(ast.sourceFile);
      const lexical = ts.isIdentifier(callee) ? binder.resolve(callee) : undefined;
      const checker = ast.checker.getSymbolAtLocation(callee);
      const scope = binder.scopeOf(callee);
      const record = {
        id: row.id,
        sourceSha256: digest(row.source),
        visited: true,
        recovered: found !== undefined,
        originalDeclarationIdentity: found !== undefined && found === lexical?.valueDeclaration,
        sourceFile: {
          fileName: ast.sourceFile.fileName,
          declarationFile: ast.sourceFile.isDeclarationFile,
          actualTextSha256: digest(ast.sourceFile.text),
          originalDeclarationSourceIdentity: found?.getSourceFile() === ast.sourceFile,
        },
        scope: {
          kind: scope.kind,
          nodeKind: ts.SyntaxKind[scope.node.kind],
          pos: scope.node.pos,
          end: scope.node.end,
          sourceBindingIdentity: ts.isIdentifier(callee) && lexical === binder.sourceScope.bindings.get(callee.text),
        },
        declarationCount: lexical?.declarations.length,
        reassigned: lexical?.reassigned,
        lexicalDeclarations: lexical?.declarations.map((decl) => ({
          kind: ts.SyntaxKind[decl.kind],
          pos: decl.pos,
          end: decl.end,
          originalSourceIdentity: decl.getSourceFile() === ast.sourceFile,
          recoveredIdentity: decl === found,
        })),
        writes: {
          incremented: lexical?.incremented,
          opaquelyWritten: lexical?.opaquelyWritten,
          assignedExpressions: lexical?.assignedExpressions.map((node) => ({
            kind: ts.SyntaxKind[node.kind],
            pos: node.pos,
            end: node.end,
            originalSourceIdentity: node.getSourceFile() === ast.sourceFile,
          })),
        },
        checkerDeclarations: checker?.getDeclarations()?.map((decl) => ({
          fileName: decl.getSourceFile().fileName,
          ambient: decl.getSourceFile().isDeclarationFile,
          kind: ts.SyntaxKind[decl.kind],
        })),
        actualInitializer: found?.initializer?.getText(ast.sourceFile),
      };
      writeFileSync(join(directory(`query-${row.id}`), "query.json"), JSON.stringify(record, null, 2));
      console.info("6929-constructor-query", JSON.stringify(record));
      expect(ast.syntacticDiagnostics).toEqual([]);
      expect(found !== undefined).toBe(row.recovered);
      if (row.recovered) {
        expect(found).toBe(lexical?.valueDeclaration);
        expect(found?.initializer).toBeDefined();
      }
    } finally {
      service.dispose();
    }
  });
  it("declines a synthesized detached identifier without manufacturing a declaration", () => {
    const service = new IncrementalLanguageService("binding.js");
    try {
      service.updateSource(QUERY_CASES[0].source);
      const ast = service.analyze({ allowJs: true, skipSemanticDiagnostics: true });
      const synthesized = ts.factory.createIdentifier("toString");
      const found = recoverAmbientPrototypeConstructorBinding(
        { oracle: createTypeOracle(ast.checker, "checker") },
        synthesized,
      );
      const receipt = {
        visited: true,
        recovered: found !== undefined,
        position: synthesized.pos,
        detached: synthesized.parent === undefined,
      };
      writeFileSync(join(directory("query-synthesized"), "query.json"), JSON.stringify(receipt, null, 2));
      expect(found).toBeUndefined();
    } finally {
      service.dispose();
    }
  });
  it("uses new SourceFile and declaration identities after incremental replacement", () => {
    const service = new IncrementalLanguageService("binding.js");
    try {
      service.updateSource(QUERY_CASES[0].source);
      const first = service.analyze({ allowJs: true, skipSemanticDiagnostics: true });
      const priorOracle = createTypeOracle(first.checker, "checker");
      const priorCallee = originalCallee(first.sourceFile);
      const priorQuery = observeSymbolQueries(first.checker, () =>
        priorOracle.bindingDeclarationEvidenceOf(priorCallee),
      );
      const priorEvidence = priorQuery.value;
      const prior = recoverAmbientPrototypeConstructorBinding({ oracle: priorOracle }, priorCallee);
      service.updateSource(QUERY_CASES[1].source);
      const second = service.analyze({ allowJs: true, skipSemanticDiagnostics: true });
      const nextOracle = createTypeOracle(second.checker, "checker");
      const nextCallee = originalCallee(second.sourceFile);
      const nextQuery = observeSymbolQueries(second.checker, () => nextOracle.bindingDeclarationEvidenceOf(nextCallee));
      const nextEvidence = nextQuery.value;
      const next = recoverAmbientPrototypeConstructorBinding({ oracle: nextOracle }, nextCallee);
      const receipt = {
        visited: 2,
        priorRecovered: prior !== undefined,
        nextRecovered: next !== undefined,
        newSourceIdentity: second.sourceFile !== first.sourceFile,
        newDeclarationIdentity: next !== prior,
        newBinderIdentity: binderFor(second.sourceFile) !== binderFor(first.sourceFile),
        newOracleIdentity: nextOracle !== priorOracle,
        newCalleeIdentity: nextCallee !== priorCallee,
        reusedUnchangedCalleeIdentity: nextCallee === priorCallee,
        newEvidenceIdentity: nextEvidence !== priorEvidence,
        priorCalleeCheckerQueries: priorQuery.queries.length,
        nextCalleeCheckerQueries: nextQuery.queries.length,
        originalPriorDeclarationSource: prior?.getSourceFile() === first.sourceFile,
        originalNextDeclarationSource: next?.getSourceFile() === second.sourceFile,
      };
      const capture = directory("query-source-replacement");
      writeFileSync(join(capture, "query.json"), JSON.stringify(receipt, null, 2));
      expect(prior).toBeDefined();
      expect(next).toBeDefined();
      expect(second.sourceFile).not.toBe(first.sourceFile);
      expect(next).not.toBe(prior);
      expect(binderFor(second.sourceFile)).not.toBe(binderFor(first.sourceFile));
      expect(nextOracle).not.toBe(priorOracle);
      // The exact edit changes the initializer; TypeScript reuses the unchanged
      // function subtree. Distinct generation oracles must query even this SAME id.
      expect(nextCallee).toBe(priorCallee);
      expect(priorQuery.queries.map((query) => query.node)).toEqual([priorCallee]);
      expect(nextQuery.queries.map((query) => query.node)).toEqual([nextCallee]);
      expect(nextEvidence).not.toBe(priorEvidence);
      expect(priorOracle.bindingDeclarationEvidenceOf(priorCallee)).toBe(priorEvidence);
      expect(nextOracle.bindingDeclarationEvidenceOf(nextCallee)).toBe(nextEvidence);

      // A separate source-query phase changes the actual new-expression syntax
      // so new-node isolation is proved as well as the genuine subtree reuse.
      const changedSource = QUERY_CASES[1].source.replace("new toString();", "new toString(0);");
      expect(changedSource).not.toBe(QUERY_CASES[1].source);
      service.updateSource(changedSource);
      const third = service.analyze({ allowJs: true, skipSemanticDiagnostics: true });
      const changedNew = uniqueNew(third.sourceFile);
      const changedCallee = originalCallee(third.sourceFile);
      const changedOracle = createTypeOracle(third.checker, "checker");
      const changedQuery = observeSymbolQueries(third.checker, () =>
        changedOracle.bindingDeclarationEvidenceOf(changedCallee),
      );
      const changedEvidence = changedQuery.value;
      const changed = recoverAmbientPrototypeConstructorBinding({ oracle: changedOracle }, changedNew.expression);
      const completeReceipt = {
        ...receipt,
        totalSourceQueryPhases: 3,
        deliberatelyChangedCall: {
          sourceSha256: digest(changedSource),
          actualTextSha256: digest(third.sourceFile.text),
          newSourceIdentity: third.sourceFile !== second.sourceFile,
          newCalleeIdentity: changedCallee !== nextCallee && changedCallee !== priorCallee,
          newOracleIdentity: changedOracle !== nextOracle && changedOracle !== priorOracle,
          newEvidenceIdentity: changedEvidence !== nextEvidence && changedEvidence !== priorEvidence,
          calleeCheckerQueries: changedQuery.queries.length,
          originalDeclarationSourceIdentity: changed?.getSourceFile() === third.sourceFile,
          recovered: changed !== undefined,
        },
      };
      writeFileSync(join(capture, "query.json"), JSON.stringify(completeReceipt, null, 2));
      expect(third.syntacticDiagnostics).toEqual([]);
      expect(changedNew.arguments).toHaveLength(1);
      expect(changedNew.arguments?.[0]?.getText(third.sourceFile)).toBe("0");
      expect(third.sourceFile).not.toBe(second.sourceFile);
      expect(changedCallee).not.toBe(nextCallee);
      expect(changedCallee).not.toBe(priorCallee);
      expect(changedOracle).not.toBe(nextOracle);
      expect(changedOracle).not.toBe(priorOracle);
      expect(changedEvidence).not.toBe(nextEvidence);
      expect(changedEvidence).not.toBe(priorEvidence);
      expect(changedQuery.queries.map((query) => query.node)).toEqual([changedCallee]);
      expect(changed).toBeDefined();
      expect(changed).toBe(binderFor(third.sourceFile).resolve(changedCallee)?.valueDeclaration);
      expect(changed?.getSourceFile()).toBe(third.sourceFile);
      expect(changedOracle.bindingDeclarationEvidenceOf(changedCallee)).toBe(changedEvidence);
      expect(priorOracle.bindingDeclarationEvidenceOf(priorCallee)).toBe(priorEvidence);
      expect(nextOracle.bindingDeclarationEvidenceOf(nextCallee)).toBe(nextEvidence);
    } finally {
      service.dispose();
    }
  });
  it.each(STRICT_EVIDENCE_CASES)("strict oracle successful query/cache: $id", (row) => {
    withBindingAst(row.source, (ast) => {
      const callee = originalCallee(ast.sourceFile);
      const symbol = ast.checker.getSymbolAtLocation(callee);
      const declarations = symbol?.getDeclarations() ?? [];
      const valueDeclaration = symbol?.valueDeclaration;
      const oracle = createTypeOracle(ast.checker, "checker");
      // Prepopulate the legacy lossy caches; strict evidence must still query once.
      oracle.declarationsOf(callee);
      oracle.valueDeclarationOf(callee);
      const observed = observeSymbolQueries(ast.checker, () => {
        const evidence = oracle.bindingDeclarationEvidenceOf(callee);
        expect(oracle.bindingDeclarationEvidenceOf(callee)).toBe(evidence);
        expect(oracle.bindingDeclarationEvidenceOf(callee)).toBe(evidence);
        return evidence;
      });
      expect(observed.queries).toHaveLength(1);
      expect(observed.queries[0]?.node).toBe(callee);
      expect(observed.queries[0]?.symbol).toBe(symbol);
      expect(observed.value.kind).toBe(row.kind);
      expect(Object.isFrozen(observed.value)).toBe(true);
      if (observed.value.kind === "resolved") {
        expect(declarations.length).toBeGreaterThan(0);
        expect(observed.value.declarations).not.toBe(declarations);
        expect(Object.isFrozen(observed.value.declarations)).toBe(true);
        expect(observed.value.declarations).toHaveLength(declarations.length);
        declarations.forEach((declaration, index) => {
          expect(observed.value.kind === "resolved" && observed.value.declarations[index]).toBe(declaration);
          expect(declaration.getSourceFile().isDeclarationFile).toBe(row.ambient);
          if (!row.ambient) expect(declaration.getSourceFile()).toBe(ast.sourceFile);
        });
        expect(observed.value.valueDeclaration).toBe(valueDeclaration);
      } else {
        expect(symbol).toBeUndefined();
        expect(observed.value.kind).not.toBe("unknown");
      }
      strictReceipt(row.id, {
        actualCheckerCalls: observed.queries.length,
        repeatedQueries: 3,
        evidence: evidenceRecord(observed.value),
      });
    });
  });
  it("strict oracle caches only within the actual oracle instance", () => {
    withBindingAst(QUERY_CASES[0].source, (ast) => {
      const callee = originalCallee(ast.sourceFile);
      const first = createTypeOracle(ast.checker, "checker");
      const second = createTypeOracle(ast.checker, "checker");
      const observed = observeSymbolQueries(ast.checker, () => {
        const prior = first.bindingDeclarationEvidenceOf(callee);
        const next = second.bindingDeclarationEvidenceOf(callee);
        expect(first.bindingDeclarationEvidenceOf(callee)).toBe(prior);
        expect(second.bindingDeclarationEvidenceOf(callee)).toBe(next);
        expect(next).not.toBe(prior);
        return [prior, next];
      });
      expect(observed.queries).toHaveLength(2);
      expect(observed.queries.every((query) => query.node === callee)).toBe(true);
      strictReceipt("per-oracle-cache", {
        actualCheckerCalls: observed.queries.length,
        distinctOracles: first !== second,
        evidence: observed.value.map(evidenceRecord),
      });
    });
  });
  it("strict in-house unavailable evidence declines the actual recovered binding", () => {
    withBindingAst(QUERY_CASES[0].source, (ast) => {
      const callee = originalCallee(ast.sourceFile);
      const root = prototypeRoot(ast.sourceFile);
      const checkerOracle = createTypeOracle(ast.checker, "checker");
      const declaration = recoverAmbientPrototypeConstructorBinding({ oracle: checkerOracle }, callee);
      expect(declaration).toBe(binderFor(ast.sourceFile).resolve(callee)?.valueDeclaration);
      expect(declaration).toBeDefined();
      const oracle = createTypeOracle(ast.checker, "inhouse");
      const observed = observeSymbolQueries(ast.checker, () => {
        const evidence = [oracle.bindingDeclarationEvidenceOf(callee), oracle.bindingDeclarationEvidenceOf(root)];
        expect(evidence.map((value) => value.kind)).toEqual(["unknown", "unknown"]);
        expect(recoverAmbientPrototypeConstructorBinding({ oracle }, callee)).toBeUndefined();
        return evidence;
      });
      expect(observed.queries).toHaveLength(0);
      strictReceipt("inhouse-unavailable-refusal", {
        actualCheckerCalls: 0,
        genuineCheckerRecovery: true,
        evidence: observed.value.map(evidenceRecord),
      });
    });
  });
  it("strict differential returns the exact primary evidence and records in-house abstention", () => {
    withBindingAst(`${QUERY_CASES[0].source} missingConstructor;`, (ast) => {
      const callee = originalCallee(ast.sourceFile);
      const root = prototypeRoot(ast.sourceFile);
      const last = ast.sourceFile.statements.at(-1);
      if (!last || !ts.isExpressionStatement(last) || !ts.isIdentifier(last.expression)) {
        throw new Error("UNKNOWN genuine absent identifier");
      }
      const absent = last.expression;
      expect(ast.checker.getSymbolAtLocation(absent)).toBeUndefined();
      const primary = createTypeOracle(ast.checker, "checker");
      const candidate = createTypeOracle(ast.checker, "inhouse");
      const ledger = new DivergenceLedger();
      const oracle = new DifferentialOracle(primary, candidate, ledger);
      const evidence = [callee, root, absent].map((node) => {
        const exactPrimary = primary.bindingDeclarationEvidenceOf(node);
        expect(oracle.bindingDeclarationEvidenceOf(node)).toBe(exactPrimary);
        return exactPrimary;
      });
      expect(evidence.map((value) => value.kind)).toEqual(["resolved", "resolved", "absent"]);
      expect(ledger.summary()).toEqual({ agreements: 0, weakened: 3, checkerWeaker: 0, conflicting: 0, total: 3 });
      expect(ledger.byQuery.get("bindingDeclarationEvidenceOf")?.weakened).toBe(3);
      expect(ledger.samples).toHaveLength(3);
      expect(
        ledger.samples.every((sample) => sample.inhouse === "unknown" && sample.verdict === "inhouse-weaker"),
      ).toBe(true);
      for (const sample of ledger.samples.slice(0, 2)) {
        const description = JSON.parse(sample.checker);
        expect(description.kind).toBe("resolved");
        expect(description.declarations.length).toBeGreaterThan(0);
        expect(
          description.declarations.every(
            (node: { ambient: boolean; fileName: string }) => node.ambient && node.fileName.length > 0,
          ),
        ).toBe(true);
        expect(description).toHaveProperty("valueDeclaration");
      }
      expect(ledger.samples[2]?.checker).toBe("absent");
      strictReceipt("differential-primary-and-ledger", {
        evidence: evidence.map(evidenceRecord),
        ledger: ledger.summary(),
        samples: ledger.samples,
      });
    });
  });
  it("strict differential factory descriptions distinguish original source provenance", () => {
    globalDivergenceLedger.reset();
    try {
      for (const fileName of ["strict-first.js", "strict-second.js"]) {
        withBindingAst(
          QUERY_CASES[5].source,
          (ast) => {
            const oracle = createTypeOracle(ast.checker, "differential");
            const callee = originalCallee(ast.sourceFile);
            const evidence = oracle.bindingDeclarationEvidenceOf(callee);
            expect(evidence.kind).toBe("resolved");
            if (evidence.kind !== "resolved") throw new Error("UNKNOWN source evidence");
            expect(evidence.declarations[0]?.getSourceFile()).toBe(ast.sourceFile);
            const sample = globalDivergenceLedger.samples.at(-1);
            expect(sample?.verdict).toBe("inhouse-weaker");
            const description = JSON.parse(sample!.checker);
            expect(description.declarations[0].fileName).toBe(ast.sourceFile.fileName);
            expect(description.declarations[0].ambient).toBe(false);
            expect(description.declarations[0].pos).toBe(evidence.declarations[0]?.pos);
            expect(description.declarations[0].end).toBe(evidence.declarations[0]?.end);
            expect(description.valueDeclaration.fileName).toBe(ast.sourceFile.fileName);
          },
          fileName,
        );
      }
      expect(globalDivergenceLedger.samples).toHaveLength(2);
      expect(globalDivergenceLedger.samples[0]?.checker).not.toBe(globalDivergenceLedger.samples[1]?.checker);
      expect(globalDivergenceLedger.summary().weakened).toBe(2);
      strictReceipt("differential-factory-source-provenance", {
        ledger: globalDivergenceLedger.summary(),
        samples: globalDivergenceLedger.samples,
      });
    } finally {
      globalDivergenceLedger.reset();
    }
  });
  it.each(["callee", "root"] as const)(
    "strict fault injection propagates the identical %s checker error without caching",
    (site) => {
      withBindingAst(QUERY_CASES[0].source, (ast) => {
        const callee = originalCallee(ast.sourceFile);
        const target = site === "callee" ? callee : prototypeRoot(ast.sourceFile);
        const oracle = createTypeOracle(ast.checker, "checker");
        const sentinel = new Error(`6929 strict ${site} checker fault injection`);
        const failures = observeSymbolQueries(
          ast.checker,
          () => {
            for (let attempt = 0; attempt < 2; attempt++) {
              let caught: unknown;
              let declaration: ts.VariableDeclaration | undefined;
              try {
                declaration = recoverAmbientPrototypeConstructorBinding({ oracle }, callee);
              } catch (error) {
                caught = error;
              }
              expect(caught).toBe(sentinel);
              expect(declaration).toBeUndefined();
            }
          },
          { node: target, sentinel },
        );
        const faultQueries = failures.queries.filter((query) => query.node === target);
        expect(faultQueries).toHaveLength(2);
        expect(faultQueries.every((query) => query.symbol !== undefined)).toBe(true);
        const retry = observeSymbolQueries(ast.checker, () =>
          recoverAmbientPrototypeConstructorBinding({ oracle }, callee),
        );
        expect(retry.value).toBe(binderFor(ast.sourceFile).resolve(callee)?.valueDeclaration);
        expect(retry.value).toBeDefined();
        expect(retry.queries.filter((query) => query.node === target)).toHaveLength(1);
        const freshOracle = createTypeOracle(ast.checker, "checker");
        const fresh = observeSymbolQueries(ast.checker, () =>
          recoverAmbientPrototypeConstructorBinding({ oracle: freshOracle }, callee),
        );
        expect(fresh.value).toBe(retry.value);
        expect(fresh.queries.map((query) => query.node)).toEqual([callee, prototypeRoot(ast.sourceFile)]);
        strictReceipt(`checker-fault-${site}`, {
          faultInjection: true,
          sentinel: sentinel.message,
          originalCallthroughsBeforeThrows: faultQueries.length,
          failedAttempts: 2,
          sameOracleRetryQueries: retry.queries.length,
          freshOracleQueries: fresh.queries.length,
          actualOriginalDeclarationIdentity: fresh.value === retry.value,
        });
      });
    },
  );
  it.each(["getDeclarations", "valueDeclaration"] as const)(
    "strict fault injection publishes no cache before the %s read completes",
    (read) => {
      withBindingAst(QUERY_CASES[0].source, (ast) => {
        const callee = originalCallee(ast.sourceFile);
        const symbol = ast.checker.getSymbolAtLocation(callee);
        if (!symbol) throw new Error("UNKNOWN genuine checker symbol");
        const originalDeclarations = symbol.getDeclarations;
        const descriptor = Object.getOwnPropertyDescriptor(symbol, "valueDeclaration");
        const originalValue = symbol.valueDeclaration;
        const oracle = createTypeOracle(ast.checker, "checker");
        const sentinel = new Error(`6929 strict ${read} accessor fault injection`);
        let accessorCalls = 0;
        const declarationObserver =
          read === "getDeclarations"
            ? vi.spyOn(symbol, "getDeclarations").mockImplementation(() => {
                originalDeclarations.call(symbol);
                accessorCalls++;
                throw sentinel;
              })
            : undefined;
        if (read === "valueDeclaration") {
          expect(descriptor?.configurable).toBe(true);
          Object.defineProperty(symbol, "valueDeclaration", {
            configurable: true,
            get() {
              const value = descriptor?.get ? descriptor.get.call(symbol) : descriptor?.value;
              expect(value).toBe(originalValue);
              accessorCalls++;
              throw sentinel;
            },
          });
        }
        let failedCheckerCalls = 0;
        try {
          const observed = observeSymbolQueries(ast.checker, () => {
            for (let attempt = 0; attempt < 2; attempt++) {
              let caught: unknown;
              let returned: BindingDeclarationEvidence | undefined;
              try {
                returned = oracle.bindingDeclarationEvidenceOf(callee);
              } catch (error) {
                caught = error;
              }
              expect(caught).toBe(sentinel);
              expect(returned).toBeUndefined();
            }
          });
          failedCheckerCalls = observed.queries.length;
          expect(failedCheckerCalls).toBe(2);
          expect(accessorCalls).toBe(2);
        } finally {
          declarationObserver?.mockRestore();
          if (read === "valueDeclaration" && descriptor) Object.defineProperty(symbol, "valueDeclaration", descriptor);
        }
        expect(symbol.getDeclarations).toBe(originalDeclarations);
        expect(symbol.valueDeclaration).toBe(originalValue);
        const retry = observeSymbolQueries(ast.checker, () => oracle.bindingDeclarationEvidenceOf(callee));
        expect(retry.queries).toHaveLength(1);
        expect(retry.value.kind).toBe("resolved");
        expect(oracle.bindingDeclarationEvidenceOf(callee)).toBe(retry.value);
        strictReceipt(`accessor-fault-${read}`, {
          faultInjection: true,
          sentinel: sentinel.message,
          failedCheckerCalls,
          accessorCalls,
          retryCheckerCalls: retry.queries.length,
          evidence: evidenceRecord(retry.value),
        });
      });
    },
  );
  it("strict differential preserves primary checker throws and publishes no false ledger answer", () => {
    withBindingAst(QUERY_CASES[0].source, (ast) => {
      const callee = originalCallee(ast.sourceFile);
      const primary = createTypeOracle(ast.checker, "checker");
      const ledger = new DivergenceLedger();
      const oracle = new DifferentialOracle(primary, createTypeOracle(ast.checker, "inhouse"), ledger);
      const sentinel = new Error("6929 strict differential primary checker fault injection");
      const failures = observeSymbolQueries(
        ast.checker,
        () => {
          let caught: unknown;
          let returned: BindingDeclarationEvidence | undefined;
          try {
            returned = oracle.bindingDeclarationEvidenceOf(callee);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(sentinel);
          expect(returned).toBeUndefined();
        },
        { node: callee, sentinel },
      );
      expect(failures.queries).toHaveLength(1);
      expect(ledger.summary().total).toBe(0);
      const retry = oracle.bindingDeclarationEvidenceOf(callee);
      expect(retry).toBe(primary.bindingDeclarationEvidenceOf(callee));
      expect(ledger.summary()).toEqual({ agreements: 0, weakened: 1, checkerWeaker: 0, conflicting: 0, total: 1 });
      strictReceipt("differential-primary-fault", {
        faultInjection: true,
        sentinel: sentinel.message,
        originalCallthroughsBeforeThrows: failures.queries.length,
        evidence: evidenceRecord(retry),
        ledger: ledger.summary(),
      });
    });
  });
  it("strict oracle refuses detached synthetic evidence without querying the checker", () => {
    withBindingAst(QUERY_CASES[0].source, (ast) => {
      const oracle = createTypeOracle(ast.checker, "checker");
      const detached = ts.factory.createIdentifier("toString");
      const observed = observeSymbolQueries(ast.checker, () => oracle.bindingDeclarationEvidenceOf(detached));
      expect(observed.value.kind).toBe("unknown");
      expect(observed.queries).toHaveLength(0);
      strictReceipt("synthetic-unavailable", {
        actualCheckerCalls: observed.queries.length,
        evidence: evidenceRecord(observed.value),
      });
    });
  });
  it("retains the exact unchanged nine-original manifest, including unresolved proxy-class", () => {
    expect(Object.keys(ORIGINALS)).toHaveLength(9);
    const archiveRoot = join(WORKSPACE, "tests/fixtures/issue-6929-test262-originals");
    const inputs = loadConstructorOriginalInputs({
      archiveRoot,
      corpusRoot: join(WORKSPACE, "test262"),
      expectedOriginals: ORIGINALS,
    });
    const validatorControls = runConstructorOriginalInputControls({
      archiveRoot,
      scratchRoot: directory("original-input-controls"),
      expectedOriginals: ORIGINALS,
    });
    expect(validatorControls.loaderExecutions + 1).toBe(32);
    writeFileSync(
      join(directory("canonical-nine-manifest"), "manifest.json"),
      JSON.stringify(
        {
          prefix: "test/built-ins/Function/prototype/toString/",
          originalIdentities: 9,
          sevenPriorPassingControls: 7,
          unresolvedProxyClassRetained: true,
          canonicalExecution: "ROOT REQUIRED; no verdicts from this manifest",
          rows: ORIGINALS,
          inputOrigin: inputs.inputOrigin,
          sourcePin: inputs.sourcePin,
          archive: inputs.archive,
          corpus: inputs.corpus,
          validatorControls,
        },
        null,
        2,
      ),
    );
  });
  it("registers all semantic pairs with a positive count floor", () => {
    expect(QUERY_CASES).toHaveLength(27);
    expect(BODY_CASES).toHaveLength(50);
    expect(SPECIMENS).toHaveLength(200);
    expect(new Set(SPECIMENS.map((row) => row.id)).size).toBe(200);
    writeFileSync(
      join(directory("semantic-manifest"), "manifest.json"),
      JSON.stringify(
        {
          semanticPairs: 200,
          reusedStages: 3,
          plannedCompiles: 406,
          plannedInstantiateVisits: 406,
          queryRows: 27,
          plannedQueryCalls: 30,
          existingIdentityRegistrations: 29,
          strictOracleRegistrations: STRICT_ORACLE_REGISTRATIONS,
          registrations: 232 + STRICT_ORACLE_REGISTRATIONS,
          canonicalExecution: "separate maintained worker required",
          rows: SPECIMENS.map((row) => ({
            id: row.id,
            expected: row.expected,
            sourceSha256: digest(row.source),
            options: row.options,
          })),
        },
        null,
        2,
      ),
    );
  });
  it.each(SPECIMENS)("$id", async (specimen) => {
    const record = await pair(specimen);
    assertPair(record);
  });
  it("reuses a compiler across refusal, recovered mutation and JS/TS/JS replacement", async () => {
    const service = createIncrementalCompiler();
    const records: Awaited<ReturnType<typeof pair>>[] = [];
    const stages: Specimen[] = [
      SPECIMENS.find((row) => row.id === "standalone/reassigned-before-use")!,
      {
        id: "reuse/typed.ts",
        source: "export function main(): number { return 37; }",
        expected: 37,
        options: { ...BASE, fileName: "constructor.ts" },
      },
      SPECIMENS.find((row) => row.id === "standalone/captured-original-spelling")!,
    ];
    let disposalError: string | undefined;
    try {
      for (const specimen of stages) records.push(await pair(specimen, service));
    } finally {
      try {
        service.dispose();
      } catch (error) {
        disposalError = String(error);
      }
    }
    const receipt = {
      plannedStages: 3,
      actualPairs: records.length,
      disposalError,
      captures: records.map((record) => record.capture),
    };
    writeFileSync(join(directory("reused-service"), "reuse.json"), JSON.stringify(receipt, null, 2));
    console.info("6929-constructor-reuse", JSON.stringify(receipt));
    expect(records).toHaveLength(3);
    expect(disposalError).toBeUndefined();
    for (const record of records) assertPair(record);
  });
});
