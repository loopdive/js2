// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { lowerFunctionAstToIr, type AstToIrOptions, type IrFromAstResolver } from "../src/ir/from-ast.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { irIntrinsicFuncRef, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import type { IrDirectCallLoweringPlan } from "../src/ir/ast-lowering-plans.js";
import { forEachInstrDeep, irVal, irVec, type IrInstr, type IrType } from "../src/ir/nodes.js";
import {
  IR_ASYNC_CLOCK_SNAPSHOT_FN,
  IR_ASYNC_CONSOLE_LOG_STRING_FN,
  IR_ASYNC_NUMBER_TO_STRING_FN,
  IR_ASYNC_STRING_CONCAT_5_FN,
} from "../src/ir/async-semantic-runtime.js";

const f64 = irVal({ kind: "f64" }),
  externref = irVal({ kind: "externref" });
const family = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
function nodes(root: ts.Node): ts.Node[] {
  const result: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}
function vector(nullable: boolean): Extract<IrType, { kind: "vec" }> {
  const result = irVec(f64, nullable);
  assert(result.kind === "vec");
  return result;
}

// These source-bound symbolic targets exercise B's frontend contract only.
// No runtime declaration, authenticated provider, physical index or emitted
// execution result is manufactured. A owns complete source certification.
function fixture(source = family) {
  const ast = analyzeSource(source, "native-main.ts");
  const fn = ast.sourceFile.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "main",
  );
  assert(fn?.body);
  const identity = buildIrPlanningIdentityContext(
    buildIrUnitInventory([ast.sourceFile], { entrySource: ast.sourceFile, checker: ast.checker }),
  );
  const ownerUnitId = identity.unitIdByDeclaration.get(fn);
  assert(ownerUnitId);
  const sourceNodes = nodes(fn),
    calls = sourceNodes.filter(ts.isCallExpression);
  const clocks = new Set(
    calls.filter(
      (call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "Date" &&
        call.expression.name.text === "now",
    ),
  );
  const logs = new Set(
    calls.filter(
      (call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        ts.isIdentifier(call.expression.expression) &&
        call.expression.expression.text === "console",
    ),
  );
  const numbers = new Set(
    calls.filter((call) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "toString"),
  );
  const concats = new Set([...logs].flatMap((call) => call.arguments.filter(ts.isBinaryExpression)));
  const awaits = new Set(sourceNodes.filter(ts.isAwaitExpression));
  const physical = vi.fn(() => {
    throw new Error("physical capability lookup is forbidden during symbolic preparation");
  });
  const resolver: IrFromAstResolver = {
    resolveVec: physical,
    resolveVecForElement: physical,
    resolveVecValueTypeForElement: physical,
    hasHostNumberToString: physical,
    nativeNumberToStringAvailable: physical,
    jsHostExterns: physical,
    standaloneConsoleSinkAvailable: physical,
    consoleArgVariant: physical,
    isAmbientBinding: (id) =>
      ast.checker
        .getSymbolAtLocation(id)
        ?.declarations?.every((declaration) => declaration.getSourceFile().isDeclarationFile) === true,
    preparedAsyncDateNowTarget: (call) => (clocks.has(call) ? irIntrinsicFuncRef(IR_ASYNC_CLOCK_SNAPSHOT_FN) : null),
    preparedAsyncNumberToStringTarget: (call) =>
      numbers.has(call) ? irIntrinsicFuncRef(IR_ASYNC_NUMBER_TO_STRING_FN) : null,
    preparedAsyncConsoleTarget: (call) => (logs.has(call) ? irIntrinsicFuncRef(IR_ASYNC_CONSOLE_LOG_STRING_FN) : null),
    preparedAsyncConcatFiveTarget: (expression) =>
      concats.has(expression as ts.BinaryExpression) ? irIntrinsicFuncRef(IR_ASYNC_STRING_CONCAT_5_FN) : null,
    preparedAsyncAwaitSite: (expression) =>
      awaits.has(expression) ? { operandType: externref, resultType: f64 } : null,
  };
  const logicalVectorTypes: NonNullable<AstToIrOptions["logicalVectorTypes"]> = (() => {
    const facts = new Map<
      ts.ParameterDeclaration | ts.VariableDeclaration | ts.Expression,
      Extract<IrType, { kind: "vec" }>
    >();
    const declaration = sourceNodes.find(
      (node): node is ts.VariableDeclaration =>
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "ids",
    );
    if (declaration) {
      assert(declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer));
      facts.set(declaration, vector(false));
      facts.set(declaration.initializer, vector(false));
      const symbol = ast.checker.getSymbolAtLocation(declaration.name);
      assert(symbol);
      for (const node of sourceNodes)
        if (ts.isIdentifier(node) && node !== declaration.name && ast.checker.getSymbolAtLocation(node) === symbol)
          facts.set(node, vector(false));
    }
    return facts;
  })();
  const directCalls = new Map<ts.CallExpression, IrDirectCallLoweringPlan>();
  for (const call of calls)
    if (ts.isIdentifier(call.expression)) {
      const declaration = ast.checker.getSymbolAtLocation(call.expression)?.valueDeclaration;
      if (declaration && ts.isFunctionDeclaration(declaration) && declaration.name) {
        const unitId = identity.unitIdByDeclaration.get(declaration);
        assert(unitId);
        directCalls.set(call, {
          ownerUnitId,
          target: irUnitFuncRef({ unitId, name: declaration.name.text }),
          signature: { params: [vector(true)], returnType: externref },
        });
      }
    }
  function lower(overrides: Partial<AstToIrOptions> = {}) {
    const registry = new AllocSiteRegistry();
    const lowered = lowerFunctionAstToIr(fn, {
      ownerUnitId,
      identityContext: identity,
      checker: ast.checker,
      returnTypeOverride: null,
      logicalVectorTypes,
      directCalls,
      resolver,
      allocRegistry: registry,
      ...overrides,
    });
    const rows: IrInstr[] = [];
    for (const block of lowered.main.blocks)
      for (const instruction of block.instrs) forEachInstrDeep(instruction, (row) => rows.push(row));
    return { lowered, rows, allocations: registry.snapshot() };
  }
  return { ...ast, fn, clocks, logs, numbers, concats, awaits, resolver, physical, lower, logicalVectorTypes };
}

function assertConsoleNewlineDataflow(rows: IrInstr[]) {
  const definitions = new Map<IrInstr["result"], IrInstr>();
  for (const row of rows) if (row.result !== null) definitions.set(row.result, row);
  const calls = rows
    .filter((row) => row.kind === "call")
    .filter((row) => row.target.name === IR_ASYNC_CONSOLE_LOG_STRING_FN);
  expect(calls).toHaveLength(4);
  const lines = calls.map((call) => {
    expect(call.args).toHaveLength(1);
    expect(call.result).toBeNull();
    const line = definitions.get(call.args[0]!);
    assert(line?.kind === "string.concat");
    const rendered = definitions.get(line.lhs),
      newline = definitions.get(line.rhs);
    assert(rendered && newline);
    expect(newline).toMatchObject({ kind: "string.const", value: "\n", resultType: { kind: "string" } });
    expect(rendered.resultType).toEqual({ kind: "string" });
    expect(line.resultType).toEqual({ kind: "string" });
    expect(rows.indexOf(rendered)).toBeLessThan(rows.indexOf(newline));
    expect(rows.indexOf(newline)).toBeLessThan(rows.indexOf(line));
    expect(rows.indexOf(line)).toBeLessThan(rows.indexOf(call));
    return { call, line, rendered, newline };
  });
  expect(new Set(lines.map(({ line }) => line.result)).size).toBe(4);
  expect(new Set(lines.map(({ newline }) => newline.result)).size).toBe(4);
  expect(lines[0]!.rendered).toMatchObject({ kind: "string.const", value: "async/await demo" });
  expect(lines[3]!.rendered).toMatchObject({ kind: "string.const", value: "done" });
  return { definitions, lines };
}

describe("prepared native main operations remain symbolic before physical admission", () => {
  it("lowers the original main completely with ordered calls, two real awaits and zero result types", () => {
    const f = fixture();
    expect(f.sourceFile.statements.filter(ts.isFunctionDeclaration)).toHaveLength(5);
    expect([f.clocks.size, f.logs.size, f.numbers.size, f.concats.size, f.awaits.size]).toEqual([4, 4, 4, 2, 2]);
    const { lowered, rows, allocations } = f.lower();
    expect(lowered.main.resultTypes).toEqual([]);
    expect(rows.filter((row) => row.kind === "await")).toHaveLength(2);
    expect(rows.filter((row) => row.kind === "vec.new_fixed")).toMatchObject([
      { capacity: 5, resultType: vector(false) },
    ]);
    const calls = rows.filter((row) => row.kind === "call");
    expect(calls.map((row) => row.target.name)).toEqual([
      IR_ASYNC_CONSOLE_LOG_STRING_FN,
      IR_ASYNC_CLOCK_SNAPSHOT_FN,
      "fetchAllSequential",
      IR_ASYNC_CLOCK_SNAPSHOT_FN,
      IR_ASYNC_NUMBER_TO_STRING_FN,
      IR_ASYNC_NUMBER_TO_STRING_FN,
      IR_ASYNC_STRING_CONCAT_5_FN,
      IR_ASYNC_CONSOLE_LOG_STRING_FN,
      IR_ASYNC_CLOCK_SNAPSHOT_FN,
      "fetchAllParallel",
      IR_ASYNC_CLOCK_SNAPSHOT_FN,
      IR_ASYNC_NUMBER_TO_STRING_FN,
      IR_ASYNC_NUMBER_TO_STRING_FN,
      IR_ASYNC_STRING_CONCAT_5_FN,
      IR_ASYNC_CONSOLE_LOG_STRING_FN,
      IR_ASYNC_CONSOLE_LOG_STRING_FN,
    ]);
    expect(
      calls.filter((row) => row.target.name === IR_ASYNC_STRING_CONCAT_5_FN).map((row) => row.args.length),
    ).toEqual([5, 5]);
    expect(
      calls.filter((row) => row.target.name === IR_ASYNC_CONSOLE_LOG_STRING_FN).every((row) => row.result === null),
    ).toBe(true);
    const { lines } = assertConsoleNewlineDataflow(rows);
    expect(rows.filter((row) => row.kind === "string.concat")).toEqual(lines.map(({ line }) => line));
    for (const index of [1, 2])
      expect(lines[index]!.rendered).toMatchObject({
        kind: "call",
        target: { name: IR_ASYNC_STRING_CONCAT_5_FN },
        resultType: { kind: "string" },
      });
    expect(JSON.stringify({ lowered, allocations })).not.toMatch(/typeIdx|logicalVectorTypes/);
    expect(f.physical).not.toHaveBeenCalled();
  });

  it("accepts the export-only original runtime variant with the same main and allocation evidence", () => {
    let exported = family;
    for (const name of ["fetchUser", "fetchAllSequential", "fetchAllParallel"])
      exported = exported.replace(`async function ${name}`, `export async function ${name}`);
    expect(fixture(exported).lower()).toEqual(fixture().lower());
  });

  it("retains ordered logical concatenation when the optional five-part target is absent", () => {
    const f = fixture();
    const { lowered, rows, allocations } = f.lower({
      resolver: { ...f.resolver, preparedAsyncConcatFiveTarget: () => null },
    });
    const { definitions, lines } = assertConsoleNewlineDataflow(rows);
    const calls = rows.filter((row) => row.kind === "call");
    expect(calls.map((row) => row.target.name)).toEqual([
      IR_ASYNC_CONSOLE_LOG_STRING_FN,
      IR_ASYNC_CLOCK_SNAPSHOT_FN,
      "fetchAllSequential",
      IR_ASYNC_CLOCK_SNAPSHOT_FN,
      IR_ASYNC_NUMBER_TO_STRING_FN,
      IR_ASYNC_NUMBER_TO_STRING_FN,
      IR_ASYNC_CONSOLE_LOG_STRING_FN,
      IR_ASYNC_CLOCK_SNAPSHOT_FN,
      "fetchAllParallel",
      IR_ASYNC_CLOCK_SNAPSHOT_FN,
      IR_ASYNC_NUMBER_TO_STRING_FN,
      IR_ASYNC_NUMBER_TO_STRING_FN,
      IR_ASYNC_CONSOLE_LOG_STRING_FN,
      IR_ASYNC_CONSOLE_LOG_STRING_FN,
    ]);
    expect(lowered.main.resultTypes).toEqual([]);
    expect(rows.filter((row) => row.kind === "await")).toHaveLength(2);
    const concatenations = new Set<IrInstr>();
    const leaves = (value: IrInstr): IrInstr[] => {
      expect(value.resultType).toEqual({ kind: "string" });
      if (value.kind !== "string.concat") return [value];
      concatenations.add(value);
      const lhs = definitions.get(value.lhs),
        rhs = definitions.get(value.rhs);
      assert(lhs && rhs);
      expect(rows.indexOf(lhs)).toBeLessThan(rows.indexOf(rhs));
      expect(rows.indexOf(rhs)).toBeLessThan(rows.indexOf(value));
      return [...leaves(lhs), ...leaves(rhs)];
    };
    for (const [index, prefix] of [
      [1, "sequential sum = "],
      [2, "parallel  sum = "],
    ] as const) {
      const parts = leaves(lines[index]!.rendered);
      expect(parts).toHaveLength(5);
      expect(parts[0]).toMatchObject({ kind: "string.const", value: prefix });
      expect(parts[1]).toMatchObject({ kind: "call", target: { name: IR_ASYNC_NUMBER_TO_STRING_FN } });
      expect(parts[2]).toMatchObject({ kind: "string.const", value: " (took ~" });
      expect(parts[3]).toMatchObject({ kind: "call", target: { name: IR_ASYNC_NUMBER_TO_STRING_FN } });
      expect(parts[4]).toMatchObject({ kind: "string.const", value: "ms)" });
    }
    expect(concatenations.size).toBe(8);
    const actualConcatenations = rows.filter((row) => row.kind === "string.concat");
    expect(actualConcatenations).toHaveLength(12);
    for (const { line } of lines) concatenations.add(line);
    expect(new Set(actualConcatenations)).toEqual(concatenations);
    expect(JSON.stringify({ lowered, allocations })).not.toMatch(/typeIdx|logicalVectorTypes/);
    expect(f.physical).not.toHaveBeenCalled();
  });

  for (const absent of ["console", "number", "clock"] as const)
    it(`retains an explicit refusal when the ${absent} prepared target is missing`, () => {
      const f = fixture();
      const resolver = { ...f.resolver };
      if (absent === "console") resolver.preparedAsyncConsoleTarget = () => null;
      if (absent === "number") resolver.preparedAsyncNumberToStringTarget = () => null;
      if (absent === "clock") resolver.preparedAsyncDateNowTarget = () => null;
      expect(() => f.lower({ resolver })).toThrow();
    });

  for (const [source, detail] of [
    ["export function main(): void { console.log(42); }", "console argument"],
    ['export function main(): void { console.log("a","b"); }', "console arity"],
    ['export function main(): void { console.warn("a"); }', "console method"],
    ["export function main(): void { const n=42; console.log(n.toString(16)); }", "number radix"],
    ['export function main(): void { const n="x"; console.log(n.toString()); }', "number receiver"],
  ])
    it(`rejects a contradictory prepared ${detail} without supplying fake capabilities`, () => {
      const f = fixture(source);
      expect(() => f.lower()).toThrow(/prepared/);
      expect(f.physical).not.toHaveBeenCalled();
    });

  it("rejects a false ambient console proof before lowering its arguments", () => {
    const f = fixture('export function main(): void { console.log("x"); }');
    expect(() => f.lower({ resolver: { ...f.resolver, isAmbientBinding: () => false } })).toThrow(/prepared console/);
    expect(f.physical).not.toHaveBeenCalled();
  });
  it("rejects a different symbolic callable rather than trusting its compatibility name", () => {
    const f = fixture('export function main(): void { console.log("x"); }');
    expect(() =>
      f.lower({
        resolver: {
          ...f.resolver,
          preparedAsyncConsoleTarget: () =>
            irIntrinsicFuncRef(IR_ASYNC_CLOCK_SNAPSHOT_FN, IR_ASYNC_CONSOLE_LOG_STRING_FN),
        },
      }),
    ).toThrow(/prepared console/);
    expect(f.physical).not.toHaveBeenCalled();
  });
  it("does not activate a host-free target for an ordinary caller without prepared evidence", () => {
    const f = fixture('export function main(): void { console.log("x"); }');
    expect(() =>
      f.lower({
        logicalVectorTypes: undefined,
        resolver: {
          jsHostExterns: () => false,
          standaloneConsoleSinkAvailable: () => false,
          consoleArgVariant: () => "string",
        },
      }),
    ).toThrow();
  });
});
