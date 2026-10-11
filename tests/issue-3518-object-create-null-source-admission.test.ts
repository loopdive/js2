// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/frontend/typescript.js";
import { analyzeMultiSource, preloadLibFiles } from "../src/checker/index.js";
import { prepareObjectCreateResolver } from "../src/frontend/builtins/prepare-object-create.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import { effectsOf } from "../src/ir/analysis/effects.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { sourceInput, sourcePacket, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

const primary = "export function run(){ const x=Object.create(null); return 7; }";
const symbol = "js.object.create-null";
const external = { kind: "val", val: { kind: "externref" } } as const;

function plan(text = primary, extra: Record<string, string> = {}) {
  const ast = analyzeMultiSource({ "./entry.ts": text, ...extra }, "./entry.ts");
  const root = ast.entryFile.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "run",
  );
  if (!root) throw new Error("missing original run declaration");
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  if (!calls.length) throw new Error("negative fixture has no actual call site");
  return { ast, root, calls, resolver: prepareObjectCreateResolver(ast.checker, ast.sourceFiles, root) };
}

function instructions(functions: readonly IrFunction[]): IrInstr[] {
  const result: IrInstr[] = [];
  for (const fn of functions)
    for (const block of fn.blocks)
      for (const instruction of block.instrs) forEachInstrDeep(instruction, (row) => result.push(row));
  return result;
}

describe("genuine bounded Object.create(null) source admission", () => {
  it("retains the unchanged source intrinsic, canonical ABI and symbolic provider through the codec", () => {
    const { source } = sourcePacket({ "./entry.ts": primary });
    expect(source.inventory.allUnits.map((unit) => unit.kind)).toEqual(["top-level-function"]);
    const original = instructions(source.ir.functions).filter((row) => row.kind === "call");
    expect(original).toHaveLength(1);
    expect(original[0]!.target).toEqual(irIntrinsicFuncRef(symbol));
    expect(original[0]!.args).toEqual([]);
    expect(original[0]!.result).not.toBeNull();
    expect(effectsOf(original[0]!)).toMatchObject({ readsHeap: true, writesHeap: true });
    const program = requireProgram(prepareWholeIrProgram(sourceInput({ "./entry.ts": primary })));
    const canonical = irRuntimeCallableDeclaration(irIntrinsicFuncRef(symbol))!;
    expect(canonical).toMatchObject({ params: [], results: [external] });
    for (const candidate of [program, decodePreparedIrProgram(encodePreparedIrProgram(program))]) {
      expect(() => assertPreparedIrProgram(candidate)).not.toThrow();
      expect(candidate.inventory.allUnits.map((unit) => unit.kind)).toEqual(["top-level-function"]);
      expect(candidate.derivedUnits).toEqual([]);
      expect(candidate.runtime).toHaveLength(1);
      for (const functions of [candidate.ir.functions, candidate.runtime[0]!.prepared.functions]) {
        const rows = instructions(functions);
        expect(rows.filter((row) => row.kind === "closure.new")).toHaveLength(0);
        const calls = rows.filter((row) => row.kind === "call");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.target).toEqual(canonical.ref);
        expect(calls[0]!.args).toEqual([]);
        expect(calls[0]!.result).not.toBeNull();
        expect(effectsOf(calls[0]!)).toMatchObject({ readsHeap: true, writesHeap: true });
      }
      const entries = candidate.abi.entries.filter(
        (entry) =>
          entry.contract.kind === "callable" &&
          entry.contract.ref.binding.kind === "intrinsic" &&
          entry.contract.ref.binding.symbol === symbol,
      );
      expect(entries).toHaveLength(1);
      expect(entries[0]!.contract).toMatchObject({
        kind: "callable",
        ref: canonical.ref,
        params: canonical.params,
        results: canonical.results,
      });
      const manifest = candidate.runtime[0]!.prepared.manifest;
      expect(manifest.features).toEqual([symbol]);
      expect(manifest.providers).toEqual([
        {
          id: `native.${symbol}`,
          feature: symbol,
          dependencies: [],
          hostCapabilities: [],
          supportedTargets: ["standalone"],
          supportedBackends: ["wasmgc"],
          implementation: { kind: "runtime-callable", symbol },
        },
      ]);
      expect(manifest.hostCapabilities).toEqual([]);
      const acceptance = acceptPreparedIrProgram(candidate, replayOptions("wasmgc", "standalone"));
      expect(acceptance.kind).toBe("unsupported");
      if (acceptance.kind !== "unsupported") throw new Error("logical admission granted physical execution");
      expect(acceptance.code).toBe("body-shape-rejected");
      expect(acceptance.detail).toContain(`intrinsic callable ${symbol} needs runtime function materialization`);
    }
  });

  it("binds the exact original AST call and owned statement roots", () => {
    const p = plan(),
      clone = plan();
    expect(p.resolver.preparedObjectCreateCall(p.calls[0]!)).toBe("null");
    expect(p.resolver.preparedObjectCreateCall(clone.calls[0]!)).toBeUndefined();
    expect(
      prepareObjectCreateResolver(p.ast.checker, p.ast.sourceFiles, clone.root).preparedObjectCreateCall(
        clone.calls[0]!,
      ),
    ).toBeUndefined();
    const statement = p.root.body!.statements[0]!;
    expect(
      prepareObjectCreateResolver(p.ast.checker, p.ast.sourceFiles, [statement]).preparedObjectCreateCall(p.calls[0]!),
    ).toBe("null");
    expect(
      prepareObjectCreateResolver(p.ast.checker, p.ast.sourceFiles, []).preparedObjectCreateCall(p.calls[0]!),
    ).toBeUndefined();
  });

  it.each([
    "export function run(){ Object.create(null); return 7; }",
    "Object.create(null); export function run(){ return 7; }",
  ])("retains discarded calls in genuine function and module roots: %s", (text) => {
    const input = sourceInput({ "./entry.ts": text });
    const statement = input.entrySource.statements.find(ts.isExpressionStatement);
    if (statement) {
      expect(ts.isCallExpression(statement.expression)).toBe(true);
      expect(
        prepareObjectCreateResolver(input.checker, input.sourceFiles, [statement]).preparedObjectCreateCall(
          statement.expression as ts.CallExpression,
        ),
      ).toBe("null");
    }
    const program = requireProgram(prepareWholeIrProgram(input));
    for (const candidate of [program, decodePreparedIrProgram(encodePreparedIrProgram(program))]) {
      expect(() => assertPreparedIrProgram(candidate)).not.toThrow();
      for (const functions of [candidate.ir.functions, candidate.runtime[0]!.prepared.functions]) {
        const rows = instructions(functions);
        expect(rows.filter((row) => row.kind === "closure.new")).toHaveLength(0);
        const calls = rows.filter((row) => row.kind === "call" && row.target.name === symbol);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.target).toEqual(irIntrinsicFuncRef(symbol));
        expect(calls[0]!.args).toEqual([]);
        expect(effectsOf(calls[0]!)).toMatchObject({ readsHeap: true, writesHeap: true });
      }
    }
  });

  it.each([
    ["optional call", "Object.create?.(null)"],
    ["optional member", "Object?.create(null)"],
    ["computed member", "Object['create'](null)"],
    ["zero arguments", "Object.create()"],
    ["undefined argument", "Object.create(undefined)"],
    ["numeric argument", "Object.create(7)"],
    ["asserted null", "Object.create(null as null)"],
    ["parenthesized argument", "Object.create((null))"],
    ["extra properties", "Object.create(null, {})"],
    ["extra argument effect", "Object.create(null, mark())"],
    ["spread", "Object.create(...[null])"],
    ["type arguments", "Object.create<number>(null)"],
    ["parenthesized constructor", "(Object).create(null)"],
    ["parenthesized member", "(Object.create)(null)"],
    ["member call escape", "Object.create.call(null, null)"],
  ])("refuses %s", (_label, expression) => {
    const p = plan(`export function run(){ const x=${expression}; return 7; }`);
    expect(p.calls.map(p.resolver.preparedObjectCreateCall)).toEqual(p.calls.map(() => undefined));
  });

  it.each([
    ["parameter shadow", "export function run(Object: {create(value: null): any}){ Object.create(null); return 7; }"],
    [
      "local shadow",
      "export function run(){ const Object={create(value: null){return value;}}; Object.create(null); return 7; }",
    ],
    ["null variable", "export function run(){ const value=null; Object.create(value); return 7; }"],
    ["constructor alias", "const alias=Object; export function run(){alias.create(null);return 7;}"],
    ["member alias", "const create=Object.create; export function run(){create(null);return 7;}"],
    ["constructor reassignment", "Object=Object; " + primary],
    ["member mutation", "Object.create=(value: any)=>value; " + primary],
    ["computed mutation", "Object['create']=(value: any)=>value; " + primary],
    ["member deletion", "delete Object.create; " + primary],
    ["constructor escape", "const alias=Object; " + primary],
    ["shorthand constructor escape", "const box={Object}; box.Object.create=(value:any)=>value; " + primary],
    ["export constructor escape", "export {Object as Constructor}; " + primary],
    ["member escape", "const create=Object.create; " + primary],
    ["reflective mutation", "Reflect.set(Object,'create',null); " + primary],
    ["global mutation", "globalThis.Object.create=(value: any)=>value; " + primary],
    ["global alias", "const globals=globalThis; " + primary],
    ["window alias", "const globals=window; " + primary],
    ["eval escape", "eval('Object.create=()=>null'); " + primary],
    ["indirect eval escape", "const evaluate=eval; " + primary],
    ["Function escape", "Function('Object.create=()=>null')(); " + primary],
    ["constructor property escape", "const F=(()=>{}).constructor; F('Object.create=()=>null')(); " + primary],
    ["constructor computed escape", "const F=(()=>{})['con'+'structor']; F('Object.create=()=>null')(); " + primary],
    ["constructor binding escape", "const {constructor:F}=()=>{}; F('Object.create=()=>null')(); " + primary],
    ["constructor assignment escape", "let F; ({constructor:F}=()=>{}); F('Object.create=()=>null')(); " + primary],
    [
      "reflective constructor escape",
      "const F=Reflect.get(()=>{},'constructor'); F('Object.create=()=>null')(); " + primary,
    ],
    [
      "constructor loop escape",
      "let F:any; for ({constructor:F} of [()=>{}]) {} F('Object.create=()=>null')(); " + primary,
    ],
    ["later mutation", primary + " Object.create=(value: any)=>value;"],
  ])("rejects whole-source %s", (_label, text) => {
    const p = plan(text);
    expect(p.calls.map(p.resolver.preparedObjectCreateCall)).toEqual(p.calls.map(() => undefined));
  });

  it("refuses a mutation in another supplied source and fake library augmentations", () => {
    const p = plan(primary, { "./other.ts": "Object.create=(value: any)=>value; export {};" });
    expect(p.resolver.preparedObjectCreateCall(p.calls[0]!)).toBeUndefined();
    for (const declarations of [
      "declare var Object: ObjectConstructor;",
      "interface ObjectConstructor { create(value: null): any; }",
    ]) {
      const fake = plan(primary, { "./lib.d.ts": declarations });
      expect(fake.resolver.preparedObjectCreateCall(fake.calls[0]!)).toBeUndefined();
    }
  });

  it("does not borrow another current library declaration as its resolved signature", () => {
    const p = plan();
    const signature = p.ast.checker.getResolvedSignature(p.calls[0]!)!;
    const other = p.ast.checker.resolveName("Number", undefined, ts.SymbolFlags.Value, false)!.declarations![0]!;
    const checker = {
      ...p.ast.checker,
      getResolvedSignature: () => ({ ...signature, declaration: other as ts.SignatureDeclaration }),
    } as ts.TypeChecker;
    expect(
      prepareObjectCreateResolver(checker, p.ast.sourceFiles, p.root).preparedObjectCreateCall(p.calls[0]!),
    ).toBeUndefined();
  });

  it.each([
    "argument",
    "other AST literal",
    "source text",
    "source filename",
    "declaration-file flag",
    "source membership",
    "new source statement",
    "parent",
  ])("revokes the prepared call after %s drift", (mutation) => {
    const p = plan();
    expect(p.resolver.preparedObjectCreateCall(p.calls[0]!)).toBe("null");
    if (mutation === "argument")
      Object.defineProperty(p.calls[0]!, "arguments", { value: ts.factory.createNodeArray([]) });
    if (mutation === "other AST literal") {
      const returned = p.root.body!.statements[1] as ts.ReturnStatement;
      Object.defineProperty(returned.expression!, "text", { value: "9" });
    }
    if (mutation === "source text") Object.defineProperty(p.ast.entryFile, "text", { value: primary + " " });
    if (mutation === "source filename") Object.defineProperty(p.ast.entryFile, "fileName", { value: "changed.ts" });
    if (mutation === "declaration-file flag")
      Object.defineProperty(p.ast.entryFile, "isDeclarationFile", { value: true });
    if (mutation === "source membership") (p.ast.sourceFiles as ts.SourceFile[]).splice(0, 1);
    if (mutation === "new source statement")
      Object.defineProperty(p.ast.entryFile, "statements", {
        value: ts.factory.createNodeArray([
          ...p.ast.entryFile.statements,
          ts.factory.createExpressionStatement(ts.factory.createIdentifier("Object")),
        ]),
      });
    if (mutation === "parent") Object.defineProperty(p.calls[0]!, "parent", { value: p.root });
    expect(p.resolver.preparedObjectCreateCall(p.calls[0]!)).toBeUndefined();
  });

  it("revokes cached source evidence when the compiler library AST is replaced", () => {
    const p = plan();
    expect(p.resolver.preparedObjectCreateCall(p.calls[0]!)).toBe("null");
    const library = p.ast.checker
      .resolveName("Object", undefined, ts.SymbolFlags.Value, false)!
      .declarations![0]!.getSourceFile();
    const name = library.fileName.split(/[\\/]/).at(-1)!;
    // Replace with identical text, so only the actual library AST identity changes.
    preloadLibFiles({ [name]: library.text });
    expect(p.resolver.preparedObjectCreateCall(p.calls[0]!)).toBeUndefined();
  });

  it.each([
    { target: "host", backend: "wasmgc" },
    { target: "wasi", backend: "wasmgc" },
    { target: "standalone", backend: "linear" },
  ] as const)("keeps $target/$backend outside the whole-program admission", (policy) => {
    const result = prepareIrProgramSources({ ...sourceInput({ "./entry.ts": primary }), policy });
    expect(result.kind).toBe("unsupported");
  });

  it("preserves the ordinary plain-literal path and lowerer omission", () => {
    const { source } = sourcePacket({ "./entry.ts": "export function run(){const x={value:7};return 7;}" });
    const rows = instructions(source.ir.functions);
    expect(rows.filter((row) => row.kind === "object.new")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "call" && row.target.name.startsWith("js.object.create-"))).toHaveLength(
      0,
    );
    const p = plan();
    expect(() =>
      lowerFunctionAstToIr(p.root, {
        checker: p.ast.checker,
        returnTypeOverride: { kind: "val", val: { kind: "f64" } },
      }),
    ).toThrow(/Object.*not in scope/);
  });

  it.each(["Object.create(null, mark())", "Object.create?.(null)", "Object?.create(null)", "Object.create(...[null])"])(
    "refuses malformed supplied lowerer evidence before dropping effects: %s",
    (expression) => {
      for (const statement of [`const x=${expression};`, `${expression};`]) {
        const p = plan(`export function run():number{ ${statement} return 7; }`);
        expect(() =>
          lowerFunctionAstToIr(p.root, {
            checker: p.ast.checker,
            resolver: { preparedObjectCreateCall: () => "null" },
          }),
        ).toThrow(
          expect.objectContaining({
            code: "selection-preparation-mismatch",
            message: expect.stringContaining("Object.create(null) plan has unsupported call syntax"),
          }),
        );
      }
    },
  );
});
