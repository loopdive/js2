// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { lowerFunctionAstToIr, type AstToIrOptions, type IrFromAstResolver } from "../src/ir/from-ast.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { irUnitFuncRef, irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import type { IrDirectCallLoweringPlan } from "../src/ir/ast-lowering-plans.js";
import { forEachInstrDeep, irVal, irVec, type IrFunction, type IrInstr, type IrType } from "../src/ir/nodes.js";
import { IR_ASYNC_PROMISE_ALL_NATIVE_FN } from "../src/ir/async-semantic-runtime.js";

type Vec = Extract<IrType, { kind: "vec" }>;
type FactNode = ts.ParameterDeclaration | ts.VariableDeclaration | ts.Expression;
const f64 = irVal({ kind: "f64" });
const externref = irVal({ kind: "externref" });
function vector(element = f64, nullable = true): Vec {
  const type = irVec(element, nullable);
  assert(type.kind === "vec");
  return type;
}
function allNodes(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (child: ts.Node): void => {
    nodes.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return nodes;
}
function instructions(fn: IrFunction): IrInstr[] {
  const rows: IrInstr[] = [];
  for (const block of fn.blocks)
    for (const instruction of block.instrs) forEachInstrDeep(instruction, (row) => rows.push(row));
  return rows;
}

// This is lowerer-interface evidence from real parsed/checker-bound source,
// not A's full-family certification or an executable physical backend proof.
function fixture(source: string) {
  const ast = analyzeSource(source, "logical-vector.ts");
  const fn = ast.sourceFile.statements.find(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "f",
  );
  assert(fn?.body);
  const identity = buildIrPlanningIdentityContext(
    buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker }),
  );
  const ownerUnitId = identity.unitIdByDeclaration.get(fn);
  assert(ownerUnitId);
  const facts = new Map<FactNode, Vec>();
  const physical = vi.fn(() => {
    throw new Error("physical vector resolver must not run");
  });
  const resolver: IrFromAstResolver = {
    resolveVec: physical,
    resolveVecForElement: physical,
    resolveVecValueTypeForElement: physical,
    resolveVecOutOfBoundsConst: physical,
  };
  const directCalls = new Map<ts.CallExpression, IrDirectCallLoweringPlan>();
  const params: IrType[] = fn.parameters.map(() => f64);
  const allocations = new AllocSiteRegistry();
  function bind(name: string, element = f64, readNullable?: boolean) {
    const declarations = allNodes(fn).filter(
      (n): n is ts.ParameterDeclaration | ts.VariableDeclaration =>
        (ts.isParameter(n) || ts.isVariableDeclaration(n)) && ts.isIdentifier(n.name) && n.name.text === name,
    );
    assert.equal(declarations.length, 1);
    const declaration = declarations[0]!;
    const nullable =
      ts.isParameter(declaration) || declaration.type !== undefined || ts.isAwaitExpression(declaration.initializer!);
    const declared = vector(element, nullable);
    facts.set(declaration, declared);
    if (ts.isParameter(declaration)) params[fn.parameters.indexOf(declaration)] = declared;
    const initializer = declaration.initializer;
    if (initializer && ts.isArrayLiteralExpression(initializer)) facts.set(initializer, vector(element, false));
    if (initializer && ts.isAwaitExpression(initializer)) facts.set(initializer, declared);
    const actualNullable = readNullable ?? (initializer && ts.isArrayLiteralExpression(initializer) ? false : nullable);
    const symbol = ast.checker.getSymbolAtLocation(declaration.name);
    assert(symbol);
    for (const node of allNodes(fn))
      if (ts.isIdentifier(node) && node !== declaration.name && ast.checker.getSymbolAtLocation(node) === symbol)
        facts.set(node, vector(element, actualNullable));
    return declaration;
  }
  function direct(name: string, returnType: IrType, parameterTypes: IrType[] = []) {
    const declaration = ast.sourceFile.statements.find(
      (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
    );
    assert(declaration?.name);
    const unitId = identity.unitIdByDeclaration.get(declaration);
    assert(unitId);
    const symbol = ast.checker.getSymbolAtLocation(declaration.name);
    for (const node of allNodes(fn))
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ast.checker.getSymbolAtLocation(node.expression) === symbol
      ) {
        directCalls.set(node, {
          ownerUnitId,
          target: irUnitFuncRef({ unitId, name }),
          signature: { params: parameterTypes, returnType },
        });
        if (returnType.kind === "vec") facts.set(node, returnType);
      }
  }
  function lower(overrides: Partial<AstToIrOptions> = {}) {
    return lowerFunctionAstToIr(fn, {
      ownerUnitId,
      checker: ast.checker,
      identityContext: identity,
      paramTypeOverrides: params,
      returnTypeOverride: f64,
      logicalVectorTypes: facts,
      resolver,
      allocRegistry: allocations,
      directCalls,
      ...overrides,
    }).main;
  }
  return { ...ast, fn, facts, bind, direct, params, resolver, physical, allocations, lower };
}

describe("source-bound logical vectors without physical resolution", () => {
  it("retains a nullable declaration and non-null literal/immutable reads with one real allocation", () => {
    const f = fixture("function f(): number { const values: number[] = [20, 22]; return values.length; }");
    const declaration = f.bind("values");
    const ir = f.lower(),
      rows = instructions(ir);
    const allocation = rows.find((row) => row.kind === "vec.new_fixed");
    assert(allocation?.kind === "vec.new_fixed");
    expect(f.facts.get(declaration)).toEqual(vector(f64, true));
    expect(allocation.resultType).toEqual(vector(f64, false));
    expect(allocation.elements).toHaveLength(2);
    expect(allocation.capacity).toBe(2);
    expect(f.allocations.liveSites()).toHaveLength(1);
    expect(allocation.alloc).toBeDefined();
    expect(rows.filter((row) => row.kind === "vec.len")).toHaveLength(1);
    expect(JSON.stringify({ ir, allocations: f.allocations.snapshot() })).not.toMatch(/typeIdx|logicalVectorTypes/);
    expect(f.physical).not.toHaveBeenCalled();
  });

  it("retains receiver → length → effectful argument → growth → returned length exactly once", () => {
    const f = fixture(
      "function values(): number[] { return [20]; } function next(): number { return 22; } function f(): number { return values().push(next()); }",
    );
    f.direct("values", vector());
    f.direct("next", f64);
    const rows = instructions(f.lower());
    const calls = rows.filter((row) => row.kind === "call");
    expect(calls.map((row) => row.target.name)).toEqual(["values", "next", "__ir_vec_elem_set_f64"]);
    const length = rows.find((row) => row.kind === "vec.len")!;
    expect(rows.indexOf(calls[0]!)).toBeLessThan(rows.indexOf(length));
    expect(rows.indexOf(length)).toBeLessThan(rows.indexOf(calls[1]!));
    expect(rows.indexOf(calls[1]!)).toBeLessThan(rows.indexOf(calls[2]!));
    expect(rows.at(-1)).toMatchObject({ kind: "binary", op: "f64.add" });
    expect(rows.some((row) => row.kind === "vec.set" || row.kind === "vec.set_length")).toBe(false);
    expect(f.physical).not.toHaveBeenCalled();
  });

  it("does not mistake an effectful counted push for the pure fixed-capacity optimization", () => {
    const f = fixture(
      "async function next(): Promise<number> { return 22; } function f(): number { const pending: Promise<number>[] = []; for (let i=0;i<3;i++) { pending.push(next()); } return pending.length; }",
    );
    f.bind("pending", externref);
    f.direct("next", externref);
    const rows = instructions(f.lower());
    expect(rows.filter((row) => row.kind === "vec.new_fixed")).toMatchObject([{ capacity: 0, elementType: externref }]);
    expect(rows.filter((row) => row.kind === "call").map((row) => row.target.name)).toEqual([
      "next",
      "__ir_vec_elem_set_externref",
    ]);
    expect(rows.some((row) => row.kind === "vec.set" || row.kind === "vec.set_length")).toBe(false);
    expect(f.physical).not.toHaveBeenCalled();
  });

  it("preserves the existing pure counted-push proof on its own positive control", () => {
    const f = fixture(
      "function f(): number { const values: number[] = []; for (let i=0;i<3;i++) { values.push(i); } return values.length; }",
    );
    f.bind("values");
    const rows = instructions(f.lower());
    expect(rows.filter((row) => row.kind === "vec.new_fixed")).toMatchObject([{ capacity: 3 }]);
    expect(rows.filter((row) => row.kind === "vec.set")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "vec.set_length")).toHaveLength(1);
    expect(f.physical).not.toHaveBeenCalled();
  });

  for (const element of [f64, externref])
    it(`keeps safe unsigned bounds checks and the ${JSON.stringify(element)} OOB carrier`, () => {
      const f = fixture(
        `function f(values: ${element === f64 ? "number" : "Promise<number>"}[], index: number): ${element === f64 ? "number" : "Promise<number>"} { return values[index]; }`,
      );
      f.bind("values", element);
      const rows = instructions(f.lower({ returnTypeOverride: element }));
      expect(rows.filter((row) => row.kind === "unary" && row.op === "i32.trunc_sat_f64_s")).toHaveLength(1);
      expect(rows.filter((row) => row.kind === "binary" && row.op === "i32.lt_u")).toHaveLength(1);
      expect(rows.filter((row) => row.kind === "if")).toHaveLength(1);
      expect(rows.filter((row) => row.kind === "vec.get")).toHaveLength(1);
      expect(rows.filter((row) => row.kind === "const")).toMatchObject([
        element === f64 ? { value: { kind: "f64", value: NaN } } : { value: { kind: "null" } },
      ]);
      expect(f.physical).not.toHaveBeenCalled();
    });

  it("retains the proven counted-loop fast read without unchecked fallback elsewhere", () => {
    const f = fixture(
      "function f(values: number[]): number { let sum=0; for(let i=0;i<values.length;i++){sum=sum+values[i];} return sum; }",
    );
    f.bind("values");
    const rows = instructions(f.lower());
    expect(rows.filter((row) => row.kind === "vec.get")).toHaveLength(1);
    expect(rows.filter((row) => row.kind === "binary" && row.op === "i32.lt_u")).toHaveLength(0);
    expect(f.physical).not.toHaveBeenCalled();
  });

  it("keeps Promise.all's operand carrier separate from its nullable awaited vector", () => {
    const f = fixture(
      "async function f(): Promise<number> { const pending: Promise<number>[]=[]; const results=await Promise.all(pending); return results.length; }",
    );
    f.bind("pending", externref);
    f.bind("results");
    const awaited = allNodes(f.fn).find(ts.isAwaitExpression)!;
    assert(ts.isCallExpression(awaited.expression));
    const rows = instructions(
      f.lower({
        resolver: {
          ...f.resolver,
          preparedAsyncAwaitSite: (node) =>
            node === awaited ? { operandType: externref, resultType: vector() } : null,
          preparedAsyncPromiseAllPlan: (node) =>
            node === awaited.expression
              ? {
                  target: irRuntimeFuncRef(IR_ASYNC_PROMISE_ALL_NATIVE_FN),
                  argumentType: vector(externref),
                  resultType: vector(),
                }
              : null,
        },
      }),
    );
    expect(f.facts.has(awaited.expression)).toBe(false);
    expect(rows.filter((row) => row.kind === "await")).toMatchObject([{ resultType: vector() }]);
    expect(rows.filter((row) => row.kind === "call")).toMatchObject([
      { resultType: externref, args: expect.any(Array) },
    ]);
    expect(rows.find((row) => row.kind === "call")?.args).toHaveLength(1);
    expect(f.physical).not.toHaveBeenCalled();
  });

  for (const missing of ["parameter", "declaration", "literal", "read", "parenthesized"])
    it(`rejects the missing ${missing} fact without invoking a physical resolver`, () => {
      const f = fixture(
        "function f(input: number[]): number { const values: number[]=[20]; return (values).length + input.length; }",
      );
      const parameter = f.bind("input"),
        declaration = f.bind("values");
      const paren = allNodes(f.fn).find(ts.isParenthesizedExpression)!;
      f.facts.set(paren, vector(f64, false));
      const node =
        missing === "parameter"
          ? parameter
          : missing === "declaration"
            ? declaration
            : missing === "literal"
              ? declaration.initializer!
              : missing === "parenthesized"
                ? paren
                : paren.expression;
      f.facts.delete(node);
      expect(() => f.lower()).toThrow(/logical vector/);
      expect(f.physical).not.toHaveBeenCalled();
    });

  for (const corruption of [
    "empty",
    "foreign",
    "nested",
    "name",
    "scalar-result",
    "layout",
    "element",
    "nullable-literal",
    "nullable-read",
    "override",
  ])
    it(`rejects ${corruption} source facts`, () => {
      const f = fixture(
        "function f(input: number[]): number { const values: number[]=[20]; return values.length + input.length; }",
      );
      const parameter = f.bind("input"),
        declaration = f.bind("values");
      if (corruption === "empty") f.facts.clear();
      if (corruption === "foreign")
        f.facts.set(fixture("function f(other: number[]): number {return other.length;}").fn.parameters[0]!, vector());
      if (corruption === "nested") {
        const other = fixture(
          "function f(): number { function nested(values: number[]): number {return values.length;} return 0; }",
        );
        const nested = allNodes(other.fn).filter(ts.isParameter)[0]!;
        other.facts.set(nested, vector());
        expect(() => other.lower()).toThrow(/logical vector/);
        return;
      }
      if (corruption === "name") f.facts.set(declaration.name as ts.Identifier, vector());
      if (corruption === "scalar-result") f.facts.set(allNodes(f.fn).find(ts.isPropertyAccessExpression)!, vector());
      if (corruption === "layout") f.facts.set(parameter, { ...vector(), layout: undefined });
      if (corruption === "element") f.facts.set(declaration.initializer!, vector(externref, false));
      if (corruption === "nullable-literal") f.facts.set(declaration.initializer!, vector());
      if (corruption === "nullable-read")
        for (const key of f.facts.keys()) if (ts.isIdentifier(key) && key.text === "values") f.facts.set(key, vector());
      if (corruption === "override") f.params[0] = vector(externref);
      expect(() => f.lower()).toThrow(/logical vector/);
      expect(f.physical).not.toHaveBeenCalled();
    });

  it("keeps absent-option historical behavior distinct from an enabled empty map", () => {
    const scalar = fixture("function f(): number {return 42;}");
    expect(instructions(scalar.lower({ logicalVectorTypes: undefined }))).toMatchObject([{ kind: "const" }]);
    const f = fixture("function f(): number {const values:number[]=[];return values.length;}");
    expect(() => f.lower({ logicalVectorTypes: undefined })).toThrow("physical vector resolver must not run");
    expect(f.physical).toHaveBeenCalledOnce();
    f.physical.mockClear();
    expect(() => f.lower()).toThrow(/logical vector/);
    expect(f.physical).not.toHaveBeenCalled();
  });
});
