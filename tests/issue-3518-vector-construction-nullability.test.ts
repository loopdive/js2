// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import { expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { lowerIrFunctionToWasm, type IrLowerResolver } from "../src/ir/lower.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, irVec } from "../src/ir/core/types.js";
import { forEachInstrDeep, type IrFunction } from "../src/ir/core/nodes.js";
import { createEmptyModule, type Instr, type ValType } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  createVectorBaseType,
  createVectorBackingArrayType,
  createVectorCarrierType,
} from "../src/runtime/wasmgc/values/vector-grow-store.js";
import { emitBinary } from "../src/emit/binary.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("vector-construction-nullability");
type Arm = "populated" | "empty" | "spare";
it("preserves the unsupported populated spare-capacity refusal", () => {
  const f = fixture({ kind: "f64" });
  const out: Instr[] = [];
  expect(() => new WasmGcEmitter().emitVecNewFixed(f.layout, 2, 3, 0, out)).toThrow(
    "vec capacity 3 unsupported for logical length 2",
  );
  expect(out).toStrictEqual([]);
});
function fixture(element: ValType) {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const base = tx.reserveType("base", createVectorBaseType());
  const array = tx.reserveType("array", createVectorBackingArrayType("data", element));
  const carrier = tx.reserveType(
    "carrier",
    createVectorCarrierType({ name: "vec", baseTypeIndex: base.typeIndex, arrayTypeIndex: array.typeIndex }),
  );
  const layout = {
    vecStructTypeIdx: carrier.typeIndex,
    arrayTypeIdx: array.typeIndex,
    lengthFieldIdx: 0,
    dataFieldIdx: 1,
    elementValType: element,
  };
  const resolver: IrLowerResolver = {
    resolveFunc: () => {
      throw new Error("unexpected source call; no fallback");
    },
    resolveGlobal: () => {
      throw new Error("unexpected source global");
    },
    resolveType: () => {
      throw new Error("unexpected type reference");
    },
    resolveVec: () => layout,
    resolveVecForElement: () => layout,
    internFuncType: (signature) => tx.internFunctionType(signature.params, signature.results),
  };
  return { module, tx, array, carrier, layout, resolver };
}
function sourceIr(f: ReturnType<typeof fixture>, element: ValType, arm: Arm) {
  const scalar = element.kind === "f64" ? "number" : "any";
  const source =
    arm === "spare"
      ? "export function make(x: number): number[] { const a: number[] = []; for (let i = 0; i < 3; i++) { a.push(x); } return a; }"
      : `export function make(x: ${scalar}): ${scalar}[] { return ${arm === "populated" ? "[x, x]" : "[]"}; }`;
  const ast = analyzeSource(source);
  const declaration = ast.sourceFile.statements.find(ts.isFunctionDeclaration)!;
  return lowerFunctionAstToIr(declaration, {
    ownerUnitId: identities.next("make").unitId,
    exported: true,
    ...(arm === "spare" ? { checker: ast.checker } : {}),
    paramTypeOverrides: [irVal(element)],
    returnTypeOverride: irVec(irVal(element), false),
    resolver: { resolveVec: () => f.layout, resolveVecForElement: () => f.layout },
  }).main;
}
function inspectConstruction(ir: IrFunction, count: number, capacity: number) {
  const constructions: unknown[] = [];
  for (const block of ir.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (instruction) => {
        if (instruction.kind === "vec.new_fixed")
          constructions.push({ count: instruction.elements.length, capacity: instruction.capacity });
      });
  expect(constructions).toStrictEqual([{ count, capacity }]);
}
function executable(f: ReturnType<typeof fixture>, ir: IrFunction, element: ValType) {
  const lowered = lowerIrFunctionToWasm(ir, f.resolver, new WasmGcEmitter(f.resolver)).func;
  const make = f.tx.reserveFunction("make", "make", {
    params: [element],
    results: [{ kind: "ref", typeIdx: f.carrier.typeIndex }],
  });
  const ref: ValType = { kind: "ref", typeIdx: f.carrier.typeIndex };
  const length = f.tx.reserveFunction("length", "length", { params: [ref], results: [{ kind: "i32" }] });
  const capacity = f.tx.reserveFunction("capacity", "capacity", { params: [ref], results: [{ kind: "i32" }] });
  const get = f.tx.reserveFunction("get", "get", { params: [ref, { kind: "i32" }], results: [element] });
  f.tx.freezeReservations();
  f.tx.fillFunction(make, { locals: lowered.locals, body: lowered.body });
  // Read-only probes observe the returned carrier; they never construct or patch it.
  f.tx.fillFunction(length, {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: f.carrier.typeIndex, fieldIdx: 0 },
    ],
  });
  const data: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: f.carrier.typeIndex, fieldIdx: 1 },
  ];
  f.tx.fillFunction(capacity, { locals: [], body: [...data, { op: "array.len" }] });
  f.tx.fillFunction(get, {
    locals: [],
    body: [...data, { op: "local.get", index: 1 }, { op: "array.get", typeIdx: f.array.typeIndex }],
  });
  for (const token of [make, length, capacity, get]) f.tx.defineExport("export:" + token.key, token.key, token);
  f.tx.seal();
  const scratch = make.object.locals.filter((local) => local.name.startsWith("$vec_data_"));
  expect(scratch).toHaveLength(1);
  expect(scratch[0]!.type).toStrictEqual({ kind: "ref_null", typeIdx: f.array.typeIndex });
  if (f.carrier.object.kind !== "struct") throw new Error("expected carrier");
  expect(f.carrier.object.fields[1]!.type).toStrictEqual({ kind: "ref", typeIdx: f.array.typeIndex });
  const binary = emitBinary(f.module);
  expect(WebAssembly.validate(binary as BufferSource)).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(binary as BufferSource));
  const exports = instance.exports as unknown as {
    make(x: unknown): unknown;
    length(v: unknown): number;
    capacity(v: unknown): number;
    get(v: unknown, i: number): unknown;
  };
  return { exports, make };
}
function removeSingleRefinement(body: Instr[]): number {
  let removed = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (let i = 1; i + 1 < value.length; i++) {
        if (
          value[i]?.op === "ref.as_non_null" &&
          value[i - 1]?.op === "local.get" &&
          value[i + 1]?.op === "struct.new"
        ) {
          value.splice(i, 1);
          removed++;
        }
      }
      value.forEach(visit);
    } else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(body);
  return removed;
}
for (const kind of ["f64", "externref"] as const)
  for (const arm of ["populated", "empty", "spare"] as const) {
    it(`${kind} ${arm}: real lowerer bytes execute; removing only the refinement is invalid`, () => {
      const element: ValType = { kind };
      const f = fixture(element);
      let ir: IrFunction;
      if (kind === "externref" && arm === "spare") {
        // Source counted-push admission is numeric-only. This is explicitly an IR-lowerer
        // control, not a claim that the frontend admits externref spare-capacity source.
        const builder = new IrFunctionBuilder(identities.next("make"), [irVec(irVal(element), false)], true);
        builder.addParam("x", irVal(element));
        builder.openBlock();
        const vector = builder.emitVecNewFixed([], irVal(element), irVec(irVal(element), false), 3);
        builder.terminate({ kind: "return", values: [vector] });
        ir = builder.finish();
      } else ir = sourceIr(f, element, arm);
      inspectConstruction(ir, arm === "populated" ? 2 : 0, arm === "populated" ? 2 : arm === "spare" ? 3 : 0);
      const { exports, make } = executable(f, ir, element);
      const input = kind === "f64" ? 3e9 : { retained: "identity" };
      const result = exports.make(input);
      const length = arm === "populated" ? 2 : arm === "spare" && kind === "f64" ? 3 : 0;
      expect(exports.length(result)).toBe(length);
      expect(exports.capacity(result)).toBe(arm === "spare" ? 3 : length);
      for (let i = 0; i < length; i++) expect(exports.get(result, i) === input).toBe(true);
      if (arm === "spare" && kind === "externref")
        for (let i = 0; i < 3; i++) expect(exports.get(result, i)).toBe(null);
      const mutant = structuredClone(f.module);
      const functionIndex = f.module.functions.indexOf(make.object);
      expect(removeSingleRefinement(mutant.functions[functionIndex]!.body)).toBe(1);
      const invalid = emitBinary(mutant);
      expect(WebAssembly.validate(invalid as BufferSource)).toBe(false);
      expect(() => new WebAssembly.Module(invalid as BufferSource)).toThrow(WebAssembly.CompileError);
    });
  }
