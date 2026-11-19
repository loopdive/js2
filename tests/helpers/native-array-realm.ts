// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7352 arrays) A realm whose Array contracts are exported, for the paths source cannot reach yet (a sparse or
// huge index, a miss's prototype walk, a non-array receiver, `length` writes). The program is a constructed
// typed-IR control that names the four array contracts, so the realm reserves them exactly as for source; the
// bodies are the realm's own, filled by the production reservation and fill path.
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import type { IrFunctionBuilder } from "../../src/ir/builder.js";
import { irIntrinsicFuncRef } from "../../src/ir/core/callable-bindings.js";
import { emitBinary } from "../../src/emit/binary.js";
import { nativeRealmReservationInventory } from "../../src/backend/wasmgc/program/native-realm.js";
import { nativeBuiltinFunctionArrayOperands } from "../../src/backend/wasmgc/resources/native-builtin-functions.js";
import { arrayDenseLength, arrayLength } from "../../src/runtime/wasmgc/values/array-exotic-bodies.js";
import { fillRealmFixture, prepareBackendRealmProgram, realmFixture } from "./native-realm-source-integration.js";

const EXTERNAL = { kind: "val", val: { kind: "externref" } } as const;
const NUMBER = { kind: "val", val: { kind: "f64" } } as const;
const ext = { kind: "externref" } as const,
  f64 = { kind: "f64" } as const,
  i32 = { kind: "i32" } as const;

function arrayContractCalls(builder: IrFunctionBuilder) {
  const zero = builder.emitConst({ kind: "f64", value: 0 }, NUMBER);
  const array = builder.emitCall(irIntrinsicFuncRef("js.object.create-array"), [zero], EXTERNAL)!;
  builder.emitCall(irIntrinsicFuncRef("js.object.set-index"), [array, zero, array], null);
  builder.emitCall(irIntrinsicFuncRef("js.object.get-index"), [array, zero, array], EXTERNAL);
  builder.emitCall(irIntrinsicFuncRef("js.object.set-length"), [array, zero], null);
}

export interface ArrayRealm {
  create(length: number): unknown;
  getIndex(object: unknown, index: number, receiver: unknown): unknown;
  setIndex(object: unknown, index: number, value: unknown): void;
  setLength(object: unknown, length: number): void;
  /** The canonical string of an array index (the realm's index-key helper). */
  indexKey(index: number): unknown;
  /** The descriptor pack's define: (object, key, value, descriptor word). */
  defineData(object: unknown, key: unknown, value: unknown, flags: number): void;
  boxNumber(value: number): unknown;
  unboxNumber(value: unknown): number;
  objectPrototype(): unknown;
  arrayPrototype(): unknown;
  undefinedValue(): unknown;
  /** The array's `length` field and its vector's length. */
  length(array: unknown): number;
  denseLength(array: unknown): number;
  /** The builtin tag of a native error. */
  errorTag(error: unknown): number;
  exception: WebAssembly.Tag;
}

/** The compiled realm module (about 15 s to build); each instance is a fresh realm. */
export function arrayRealmModule(): WebAssembly.Module {
  const f = realmFixture(prepareBackendRealmProgram(arrayContractCalls));
  const { tx, kernel } = f;
  const control = (name: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunction("array-control:" + name, name, { params, results });
  const controls = {
    length: control("length", [ext], [f64]),
    denseLength: control("denseLength", [ext], [i32]),
    undefinedValue: control("undefinedValue", [], [ext]),
    arrayPrototype: control("arrayPrototype", [], [ext]),
    errorTag: control("errorTag", [ext], [i32]),
  };
  const inventory = nativeRealmReservationInventory(tx, f.realm);
  const realmKey = f.requirements.description.key;
  const owned = (key: string) => inventory.functions.find((row) => row.key === realmKey + key)!;
  fillRealmFixture(f);
  const d = nativeBuiltinFunctionArrayOperands(tx, kernel)!;
  const fill = (token: (typeof controls)[keyof typeof controls], body: Instr[]) =>
    tx.fillFunction(token, { locals: [], body });
  fill(controls.length, [...arrayLength(d, 0), { op: "f64.convert_i32_u" }]);
  fill(controls.denseLength, arrayDenseLength(d, 0));
  const values = f.strings.number!.values;
  fill(controls.undefinedValue, [
    { op: "global.get", index: tx.physicalIndex(values.globals.undefined) },
    { op: "extern.convert_any" },
  ]);
  fill(controls.arrayPrototype, [{ op: "global.get", index: d.arrayPrototype }]);
  const errorType = f.realm.substrate.errors.type.typeIndex;
  fill(controls.errorTag, [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: errorType },
    { op: "struct.get", typeIdx: errorType, fieldIdx: 0 },
  ]);
  for (const [name, token] of Object.entries({
    ...controls,
    create: owned(":source-objects:js.object.create-array"),
    getIndex: owned(":source-objects:js.object.get-index"),
    setIndex: owned(":source-objects:js.object.set-index"),
    setLength: owned(":source-objects:js.object.set-length"),
    indexKey: owned(":source-objects:index-key"),
    defineData: owned(":descriptors:define-data"),
    boxNumber: values.functions.boxNumber,
    unboxNumber: values.functions.unboxNumber,
    objectPrototype: kernel.functions.objectPrototype,
    exception: kernel.exception,
  }))
    tx.defineExport("array-control:export:" + name, name, token);
  tx.seal();
  return new WebAssembly.Module(emitBinary(f.module) as BufferSource);
}
export const instantiateArrayRealm = (module: WebAssembly.Module) =>
  new WebAssembly.Instance(module).exports as unknown as ArrayRealm;
