// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { buildOrdinaryObjectLookupDefinition } from "../../src/runtime/wasmgc/values/ordinary-object-access-bodies.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { emitBinary } from "../../src/emit/binary.js";
import { readFileSync } from "node:fs";
import type { PreparedIrProgram } from "../../src/ir/program/prepared-contracts.js";
import { decodePreparedIrProgram } from "../../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../../src/ir/program-validation.js";
import { deriveNativeValueResourcePlan } from "../../src/ir/program/native-value-resources.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
} from "../../src/backend/wasmgc/resources/native-string-number.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
} from "../../src/backend/wasmgc/resources/native-values.js";
import {
  declareNativeStringCreateResources,
  reserveNativeStringCreateResources,
  fillNativeStringCreateResources,
  requireCompletedNativeStringCreate,
} from "../../src/backend/wasmgc/resources/native-string-create.js";
import { fillNativeStringOwnDescriptorResources } from "../../src/backend/wasmgc/resources/native-string-exotic-own-descriptors.js";
import { requireNativeStringLiteral } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import { planNativeStringLiteral } from "../../src/runtime/wasmgc/values/string-literal-bodies.js";
import { stringExoticFixture, fillStringExoticDependencyPhases, EXOTIC_TEXTS } from "./native-string-exotic-fixture.js";

const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" },
  f64: ValType = { kind: "f64" };
const get = (index: number): Instr => ({ op: "local.get", index });
export const CREATE_TEXTS = ["", "a", "😀", "é😀\ud800\0", "0123456789"] as const;
/** Canonical complete program data passes codec revalidation and the full validator; not frontend driver output. */
export function stringCreateFixture(
  utf8 = false,
  shifted = false,
  capacity = 2,
  mutablePlan = false,
  source?: { readonly program: PreparedIrProgram; readonly additionalLiterals: readonly string[] },
) {
  const f = stringExoticFixture(utf8, shifted, false, source?.additionalLiterals);
  const program =
    source?.program ??
    decodePreparedIrProgram(
      readFileSync(new URL("../fixtures/issue-3518-string-create-program.codec.txt", import.meta.url), "utf8"),
    );
  assertPreparedIrProgram(program);
  const valuePlan = deriveNativeValueResourcePlan(program, program.runtime[0]!, "native-string");
  const scanner = reserveNativeStringNumberResources(f.tx, valuePlan, f.flatten);
  const valueDependencies = { strings: { kind: "native-string" as const, stringPack: f.strings, scanner } };
  const values = reserveNativeValueResources(f.tx, valuePlan, valueDependencies);
  const dependencies = {
    layouts: f.layouts,
    layoutPlan: f.layoutPlan,
    layoutDependencies: f.layoutDependencies,
    storage: f.storage,
    storageDependencies: f.storageDependencies,
    values,
    valuePlan,
    valueDependencies,
    ownDescriptors: f.pack,
    ownDescriptorDependencies: f.dependencies,
  };
  // The issued AnyString key comes from the existing literal pack, never a guessed type coordinate.
  const anyString = f.strings.types.find((row) => row.typeIndex === f.anyString)!;
  const canonical = declareNativeStringCreateResources("string-create", anyString.key, capacity);
  const plan = mutablePlan ? structuredClone(canonical) : canonical;
  const create = reserveNativeStringCreateResources(f.tx, "string-create", plan, dependencies);
  return {
    ...f,
    program,
    scanner,
    valuePlan,
    valueDependencies,
    values,
    createDependencies: dependencies,
    createPlan: plan,
    create,
  };
}
export type StringCreateFixture = ReturnType<typeof stringCreateFixture>;
export function* fillStringCreateDependencyPhases(f: StringCreateFixture): Generator<string, void> {
  yield* fillStringExoticDependencyPhases(f);
  fillNativeStringOwnDescriptorResources(f.tx, f.pack);
  yield "String own descriptors";
  fillNativeStringNumberResources(f.tx, f.scanner);
  yield "String number scanner";
  fillNativeValueResources(f.tx, f.values, f.valueDependencies);
  yield "native values";
}
export function fillStringCreateDependencies(f: StringCreateFixture): void {
  for (const _phase of fillStringCreateDependencyPhases(f)) {
    /* Preserve synchronous callers. */
  }
}

export function completeStringCreateFixture(f = stringCreateFixture()) {
  f.tx.freezeReservations();
  fillStringCreateDependencies(f);
  fillNativeStringCreateResources(f.tx, f.create);
  requireCompletedNativeStringCreate(f.tx, f.create, f.createDependencies);
  return f;
}
export interface StringCreateRuntime {
  text(index: number): object;
  key(index: number): object;
  root(): object;
  implicitRoot(): object;
  lookupStatus(object: object, key: object): number;
  make(prototype: unknown, payload: unknown): object;
  payload(object: object): object;
  prototype(object: object): object | null;
  table(object: object): object;
  sameObject(a: object, b: object): number;
  sameTable(a: object, b: object): number;
  count(object: object): number;
  tombstones(object: object): number;
  flags(object: object): number;
  nextSeq(object: object): number;
  lengthValue(object: object): number;
  lengthFlags(object: object): number;
  lengthSeq(object: object): number;
  absent(object: object): number;
  ownFlags(object: object, key: object): number;
  ownValue(object: object, key: object): unknown;
  codeUnit(value: unknown, index: number): number;
  isUtf8(value: unknown): number;
  slice(): object;
  rope(left: object, right: object): object;
  header(length: number): object;
  put(object: object, key: object, value: number): void;
}
export function* stringCreateRuntimePhases(
  utf8 = false,
  shifted = false,
  capacity = 2,
  source?: Parameters<typeof stringCreateFixture>[4],
  extension?: (fixture: StringCreateFixture) => () => void | Generator<string, void>,
) {
  const f = stringCreateFixture(utf8, shifted, capacity, false, source),
    { tx } = f;
  const fillExtension = extension?.(f);
  const objectType = f.objects.object.typeIndex,
    entryType = f.objects.propEntry.typeIndex;
  const object = (index: number): Instr[] => [
    get(index),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: objectType },
  ];
  const string = (index: number): Instr[] => [
    get(index),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.anyString },
  ];
  const signatures: Record<string, { params: ValType[]; results: ValType[] }> = {
    text: { params: [i32], results: [ext] },
    key: { params: [i32], results: [ext] },
    root: { params: [], results: [ext] },
    implicitRoot: { params: [], results: [ext] },
    lookupStatus: { params: [ext, ext], results: [i32] },
    make: { params: [ext, ext], results: [ext] },
    payload: { params: [ext], results: [ext] },
    prototype: { params: [ext], results: [ext] },
    table: { params: [ext], results: [ext] },
    sameObject: { params: [ext, ext], results: [i32] },
    sameTable: { params: [ext, ext], results: [i32] },
    count: { params: [ext], results: [i32] },
    tombstones: { params: [ext], results: [i32] },
    flags: { params: [ext], results: [i32] },
    nextSeq: { params: [ext], results: [i32] },
    lengthValue: { params: [ext], results: [f64] },
    lengthFlags: { params: [ext], results: [i32] },
    lengthSeq: { params: [ext], results: [i32] },
    absent: { params: [ext], results: [i32] },
    ownFlags: { params: [ext, ext], results: [i32] },
    ownValue: { params: [ext, ext], results: [ext] },
    codeUnit: { params: [ext, i32], results: [i32] },
    isUtf8: { params: [ext], results: [i32] },
    slice: { params: [], results: [ext] },
    rope: { params: [ext, ext], results: [ext] },
    header: { params: [i32], results: [ext] },
    put: { params: [ext, ext, f64], results: [] },
  };
  const observers = Object.fromEntries(
    Object.entries(signatures).map(([name, signature]) => [
      name,
      tx.reserveFunction("observer:" + name, name, signature),
    ]),
  );
  const lookup = tx.reserveFunction("observer:prototype-lookup", "prototype_lookup", {
    params: [{ kind: "ref", typeIdx: objectType }, ext],
    results: [i32, { kind: "ref_null", typeIdx: entryType }],
  });
  yield "reserved native runtime";
  tx.freezeReservations();
  yield "frozen reservations";
  yield* fillStringCreateDependencyPhases(f);
  fillNativeStringCreateResources(tx, f.create);
  requireCompletedNativeStringCreate(tx, f.create, f.createDependencies);
  yield "completed String constructor";
  const extensionPhases = fillExtension?.();
  if (extensionPhases) yield* extensionPhases;
  const literal = (text: string): Instr[] => {
    const binding = requireNativeStringLiteral(tx, f.strings, text, "wtf16");
    return binding.kind === "global"
      ? [{ op: "global.get", index: tx.physicalIndex(binding.global) }]
      : [{ op: "call", funcIdx: binding.function.handle }];
  };
  const body = (name: string, instructions: Instr[]) =>
    tx.fillFunction(observers[name]!, { locals: [], body: instructions });
  body("text", [
    ...CREATE_TEXTS.flatMap((text, index): Instr[] => {
      const encoding = utf8 && !text.includes("\ud800") ? "utf8-guaranteed" : "wtf16";
      const plan = planNativeStringLiteral(f.strings.layout, utf8, text, encoding);
      if (plan.kind !== "global") throw Error("fixture inline payload is oversized");
      return [
        get(0),
        { op: "i32.const", value: index },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...plan.init, { op: "extern.convert_any" }, { op: "return" }],
        },
      ];
    }),
    { op: "unreachable" },
  ]);
  body("key", [
    ...EXOTIC_TEXTS.flatMap((text, index): Instr[] => [
      get(0),
      { op: "i32.const", value: index },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...literal(text), { op: "extern.convert_any" }, { op: "return" }],
      },
    ]),
    { op: "unreachable" },
  ]);
  body("root", [{ op: "call", funcIdx: f.storage.createNull.handle }]);
  body("implicitRoot", [{ op: "call", funcIdx: f.storage.createDefault.handle }]);
  tx.fillFunction(
    lookup,
    buildOrdinaryObjectLookupDefinition({
      objectTypeIdx: objectType,
      propEntryTypeIdx: entryType,
      findOwnIdx: f.pack.findOwn.handle,
    }),
  );
  body("lookupStatus", [...object(0), get(1), { op: "call", funcIdx: lookup.handle }, { op: "drop" }]);
  body("make", [get(0), ...string(1), { op: "call", funcIdx: f.create.create.handle }]);
  body("payload", [get(0), { op: "call", funcIdx: f.wrappers.read.String.handle }, { op: "extern.convert_any" }]);
  body("prototype", [
    ...object(0),
    { op: "struct.get", typeIdx: objectType, fieldIdx: 0 },
    { op: "extern.convert_any" },
  ]);
  body("table", [...object(0), { op: "struct.get", typeIdx: objectType, fieldIdx: 1 }, { op: "extern.convert_any" }]);
  body("sameObject", [...object(0), ...object(1), { op: "ref.eq" }]);
  body("sameTable", [
    ...object(0),
    { op: "struct.get", typeIdx: objectType, fieldIdx: 1 },
    ...object(1),
    { op: "struct.get", typeIdx: objectType, fieldIdx: 1 },
    { op: "ref.eq" },
  ]);
  for (const [name, fieldIdx] of [
    ["count", 2],
    ["tombstones", 3],
    ["flags", 4],
    ["nextSeq", 5],
  ] as const)
    body(name, [...object(0), { op: "struct.get", typeIdx: objectType, fieldIdx }]);
  const lengthEntry: Instr[] = [
    ...object(0),
    ...literal("length"),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: f.pack.findOwn.handle },
    { op: "ref.as_non_null" },
  ];
  body("lengthValue", [
    ...lengthEntry,
    { op: "struct.get", typeIdx: entryType, fieldIdx: 1 },
    { op: "extern.convert_any" },
    { op: "call", funcIdx: f.values.functions.unboxNumber.handle },
  ]);
  body("lengthFlags", [...lengthEntry, { op: "struct.get", typeIdx: entryType, fieldIdx: 2 }]);
  body("lengthSeq", [...lengthEntry, { op: "struct.get", typeIdx: entryType, fieldIdx: 3 }]);
  body("absent", [
    ...object(0),
    ...literal("own"),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: f.lookup.findOwn.handle },
    { op: "ref.is_null" },
  ]);
  tx.fillFunction(observers.ownFlags!, {
    locals: [{ name: "entry", type: { kind: "ref_null", typeIdx: entryType } }],
    body: [
      ...object(0),
      get(1),
      { op: "call", funcIdx: f.pack.findOwn.handle },
      { op: "local.tee", index: 2 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: -1 }, { op: "return" }] },
      get(2),
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: entryType, fieldIdx: 2 },
    ],
  });
  body("ownValue", [
    ...object(0),
    get(1),
    { op: "call", funcIdx: f.pack.findOwn.handle },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: entryType, fieldIdx: 1 },
    { op: "extern.convert_any" },
  ]);
  tx.fillFunction(observers.codeUnit!, {
    locals: [{ name: "flat", type: { kind: "ref", typeIdx: f.flatString } }],
    body: [
      ...string(0),
      { op: "call", funcIdx: f.flatten.flatten.handle },
      { op: "local.set", index: 2 },
      get(2),
      { op: "struct.get", typeIdx: f.flatString, fieldIdx: 2 },
      get(2),
      { op: "struct.get", typeIdx: f.flatString, fieldIdx: 1 },
      get(1),
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: f.dataString },
    ],
  });
  body("isUtf8", [
    get(0),
    { op: "any.convert_extern" },
    utf8 ? { op: "ref.test", typeIdx: f.strings.layout.utf8StrTypeIdx } : { op: "ref.is_null" },
  ]);
  body("rope", [
    ...string(0),
    { op: "struct.get", typeIdx: f.anyString, fieldIdx: 0 },
    ...string(1),
    { op: "struct.get", typeIdx: f.anyString, fieldIdx: 0 },
    { op: "i32.add" },
    ...string(0),
    ...string(1),
    { op: "struct.new", typeIdx: f.consString },
    { op: "extern.convert_any" },
  ]);
  body("slice", [
    { op: "i32.const", value: 5 },
    { op: "i32.const", value: 2 },
    ...literal("ppé😀\ud800\0qq"),
    { op: "ref.cast", typeIdx: f.flatString },
    { op: "struct.get", typeIdx: f.flatString, fieldIdx: 2 },
    { op: "struct.new", typeIdx: f.flatString },
    { op: "extern.convert_any" },
  ]);
  // Typed header control for unsigned arithmetic, not a claim of physically allocating a 2GiB String.
  body("header", [
    get(0),
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_fixed", typeIdx: f.dataString, length: 1 },
    { op: "struct.new", typeIdx: f.flatString },
    { op: "extern.convert_any" },
  ]);
  body("put", [
    ...object(0),
    { op: "call", funcIdx: f.storage.grow.handle },
    ...object(0),
    get(1),
    get(2),
    { op: "call", funcIdx: f.values.functions.boxNumber.handle },
    { op: "any.convert_extern" },
    { op: "i32.const", value: 7 },
    ...object(0),
    { op: "struct.get", typeIdx: objectType, fieldIdx: 5 },
    { op: "call", funcIdx: f.storage.insert.handle },
    ...object(0),
    ...object(0),
    { op: "struct.get", typeIdx: objectType, fieldIdx: 5 },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "struct.set", typeIdx: objectType, fieldIdx: 5 },
  ]);
  Object.entries(observers).forEach(([name, fn]) => tx.defineExport("observer:export:" + name, name, fn));
  yield "filled boundary observers";
  tx.seal();
  yield "sealed native module";
  const bytes = emitBinary(f.module),
    module = new WebAssembly.Module(new Uint8Array(bytes));
  if (WebAssembly.Module.imports(module).length) throw Error("native fixture contains host semantic imports");
  return { runtime: new WebAssembly.Instance(module, {}).exports as unknown as StringCreateRuntime, bytes, f };
}

export function stringCreateRuntime(...args: Parameters<typeof stringCreateRuntimePhases>) {
  const phases = stringCreateRuntimePhases(...args);
  let step = phases.next();
  while (!step.done) step = phases.next();
  return step.value;
}
