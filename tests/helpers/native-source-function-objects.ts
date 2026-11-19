// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 C — the realm's `js.function.*` adapters over the builtin-object kernel and the real closure invocation, in
// one module. The source program supplies an all-dynamic closure dispatched by `js.closure.call:1`; its body is
// test-owned (it writes `this.x = v` through the ordinary define and returns `v`), because the front end does not yet
// lower `this` or `new` on the Prepared path.
import { vi } from "vitest";
import * as driver from "../../src/compiler/ir-program-driver.js";
import { compile, type Test262CompileOptions } from "../../src/test262/test262-prepared-entry.js";
import type { PreparedIrProgram } from "../../src/ir/program/prepared-contracts.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import type { FunctionObjectRuntimeFeature } from "../../src/ir/runtime/contracts/manifest.js";
import { emitBinary } from "../../src/emit/binary.js";
import { planNativeInvocationRequirements } from "../../src/ir/program/native-invocation-requirements.js";
import {
  reserveNativeInvocationResources,
  fillNativeInvocationResources,
} from "../../src/backend/wasmgc/resources/native-invocation.js";
import { nativeSourceClosureCallableBindings } from "../../src/ir/program-native-invocation.js";
import {
  NATIVE_SOURCE_FUNCTION_LITERALS,
  reserveNativeSourceObjectResources,
  fillNativeSourceObjectResources,
} from "../../src/backend/wasmgc/resources/native-source-objects.js";
import { nativeStringLiteralInstrs } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import { buildBuiltinClosureValueInstrs } from "../../src/runtime/wasmgc/values/closure-layouts.js";
import { builtinFunctionFixture, completeBuiltinFunctionFixture } from "./native-builtin-functions.js";

const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" };

/** One all-dynamic closure of arity 1, reached by a dynamic call (#7354 Fb), so `js.closure.call:1` dispatches it. */
export const FUNCTION_OBJECT_SOURCE = "function t(fn) { return fn(2); } t(function (v) { return v; });";
/** The keys the tests use, then the adapters' own strings (their TypeError messages included). */
export const FUNCTION_OBJECT_TEXTS: readonly string[] = [
  ...new Set(["x", "length", "name", "value", ...NATIVE_SOURCE_FUNCTION_LITERALS]),
];
export const FUNCTION_OBJECT_SYMBOLS = [
  "js.function.is-callable",
  "js.function.init",
  "js.function.construct:1",
  "js.function.has-instance",
  "js.function.this",
] as const;
type FunctionObjectSymbol = (typeof FUNCTION_OBJECT_SYMBOLS)[number];
/** Each symbol as the realm's source-call collection reports it: the arity member under its family's feature. */
const FUNCTION_OBJECT_CALLS = FUNCTION_OBJECT_SYMBOLS.map((symbol) => ({
  feature: (symbol === "js.function.construct:1" ? "js.function.construct" : symbol) as FunctionObjectRuntimeFeature,
  symbol,
}));

/** The Prepared program the strict test262 entry builds for `source` (captured from the program driver). */
export async function preparedScript(source: string): Promise<PreparedIrProgram> {
  const spy = vi.spyOn(driver, "runIrProgramDriver");
  try {
    const options = {
      wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
      backend: "wasmgc",
      target: "standalone",
      sourceMap: false,
      optimize: false,
      emitWat: false,
      fileName: "test.js",
      allowJs: true,
    } as Test262CompileOptions;
    const result = await compile(source, options);
    if (result.errors.length) throw Error(JSON.stringify(result.errors));
    const driven = spy.mock.results[0]?.value as { kind: string; program?: PreparedIrProgram } | undefined;
    if (driven?.kind !== "emitted" || !driven.program) throw Error("strict entry did not drive one program");
    return driven.program;
  } finally {
    spy.mockRestore();
  }
}

export interface FunctionObjectRuntime {
  isCallable(value: unknown): number;
  init(closure: unknown, name: unknown, length: number, flags: number): void;
  construct1(callee: unknown, argument: unknown): unknown;
  hasInstance(value: unknown, callee: unknown): number;
  bindThis(strict: number): unknown;
  makeClosure(): object;
  text(index: number): object;
  functionPrototype(): object;
  objectPrototype(): object;
  undefinedValue(): object;
  boxNumber(value: number): unknown;
  unboxNumber(value: unknown): number;
  createDefault(): object;
  objectProto(object: unknown): unknown;
  /** An ordinary object's own-property count, and the attribute bits of its own `key` (which must exist). */
  ordinaryCount(object: unknown): number;
  ordinaryFlags(object: unknown, key: unknown): number;
  match(value: unknown): number;
  getPrototypeOf(value: unknown): unknown;
  get(object: unknown, key: unknown, receiver: unknown): [number, unknown];
  ownKeys(object: unknown): object;
  ownDescriptor(object: unknown, key: unknown): [number, number, unknown, unknown, unknown];
  writeOwn(object: unknown, key: unknown, value: unknown): number;
  vectorLength(vector: object): number;
  vectorAt(vector: object, index: number): unknown;
  /** The message of a thrown native Error. */
  errorMessage(error: unknown): unknown;
  currentThis: WebAssembly.Global;
  exception: WebAssembly.Tag;
}

export function functionObjectRuntime(program: PreparedIrProgram) {
  const f = builtinFunctionFixture(false, true, { program, projection: program.runtime[0]! });
  const { tx } = f,
    kernel = f.kernel!;
  const requirements = planNativeInvocationRequirements(f.sourceRequirements, {
    utf8Storage: false,
    objectAccess: f.access,
  });
  if (!requirements?.methodArities.includes(1)) throw Error("source lost its js.closure.call:1 dispatch");
  const invocation = reserveNativeInvocationResources(tx, requirements, {
    source: f.source.types,
    values: f.values,
    valuePlan: f.valuePlan,
    valueDependencies: f.valueDependencies,
    strings: f.strings,
    vectors: f.carriers.vectors,
    vectorPlan: f.carriers.vectorPlan,
  });
  const adapters = reserveNativeSourceObjectResources(tx, "realm", FUNCTION_OBJECT_CALLS, {
    layouts: f.layouts,
    storage: f.storage,
    descriptors: f.pack,
    kernel,
    errors: f.errors,
    invocation,
  });
  const adapter = (name: FunctionObjectSymbol) =>
    adapters.served.find((row) => row.key === "realm:source-objects:" + name)!.token;
  const control = (name: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunction("function-object-test:" + name, name, { params, results });
  const controls = {
    makeClosure: control("makeClosure", [], [ext]),
    text: control("text", [i32], [ext]),
    undefinedValue: control("undefinedValue", [], [ext]),
    objectProto: control("objectProto", [ext], [ext]),
    ordinaryCount: control("ordinaryCount", [ext], [i32]),
    ordinaryFlags: control("ordinaryFlags", [ext, ext], [i32]),
    vectorLength: control("vectorLength", [ext], [i32]),
    vectorAt: control("vectorAt", [ext, i32], [ext]),
    errorMessage: control("errorMessage", [ext], [ext]),
  };
  const [unit] = f.sourceRequirements.units;
  if (!unit || f.sourceRequirements.units.length !== 1) throw Error("source lost its one closure");
  const shape = f.source.types.shapes.find((row) => row.id === unit.shapeId)!;
  const slot = f.sourceSlots.get(unit.unitId)!;
  const text = (value: string): Instr[] => [
    ...nativeStringLiteralInstrs(tx, f.strings, value),
    { op: "extern.convert_any" },
  ];
  const symbol = (name: FunctionObjectSymbol) => adapter(name).handle;
  completeBuiltinFunctionFixture(
    f,
    () =>
      new Map([
        [
          unit.unitId,
          {
            locals: [],
            body: [
              { op: "i32.const", value: 1 },
              { op: "call", funcIdx: symbol("js.function.this") },
              ...text("x"),
              { op: "local.get", index: 1 },
              { op: "f64.const", value: 0xbf },
              { op: "call", funcIdx: f.pack.defineData.handle },
              { op: "local.get", index: 1 },
            ],
          },
        ],
      ]),
  );
  fillNativeInvocationResources(
    tx,
    invocation,
    nativeSourceClosureCallableBindings(tx, f.source, requirements),
    kernel.exception,
  );
  fillNativeSourceObjectResources(tx, adapters);
  const cast = (local: number, typeIdx: number): Instr[] => [
    { op: "local.get", index: local },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx },
  ];
  const fill = (name: keyof typeof controls, body: Instr[]) => tx.fillFunction(controls[name], { locals: [], body });
  fill("makeClosure", [
    ...buildBuiltinClosureValueInstrs(shape.type.typeIndex, slot.handle, 1, false),
    { op: "extern.convert_any" },
  ]);
  fill(
    "text",
    FUNCTION_OBJECT_TEXTS.reduceRight<Instr[]>(
      (otherwise, value, index) => [
        { op: "local.get", index: 0 },
        { op: "i32.const", value: index },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "val", type: ext }, then: text(value), else: otherwise },
      ],
      [{ op: "unreachable" }],
    ),
  );
  fill("undefinedValue", [
    { op: "global.get", index: tx.physicalIndex(f.values.globals.undefined) },
    { op: "extern.convert_any" },
  ]);
  fill("errorMessage", [
    ...cast(0, f.errors.type.typeIndex),
    { op: "struct.get", typeIdx: f.errors.type.typeIndex, fieldIdx: 1 },
  ]);
  fill("ordinaryCount", [
    ...cast(0, f.layouts.object.typeIndex),
    { op: "struct.get", typeIdx: f.layouts.object.typeIndex, fieldIdx: 2 },
  ]);
  fill("ordinaryFlags", [
    ...cast(0, f.layouts.object.typeIndex),
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: f.lookup.findOwn.handle },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: f.layouts.propEntry.typeIndex, fieldIdx: 2 },
    { op: "i32.const", value: 7 },
    { op: "i32.and" },
  ]);
  fill("objectProto", [
    ...cast(0, f.layouts.object.typeIndex),
    { op: "struct.get", typeIdx: f.layouts.object.typeIndex, fieldIdx: 0 },
    { op: "extern.convert_any" },
  ]);
  fill("vectorLength", [
    ...cast(0, f.argumentsPack.carrier.typeIndex),
    { op: "struct.get", typeIdx: f.argumentsPack.carrier.typeIndex, fieldIdx: 0 },
  ]);
  fill("vectorAt", [
    ...cast(0, f.argumentsPack.carrier.typeIndex),
    { op: "struct.get", typeIdx: f.argumentsPack.carrier.typeIndex, fieldIdx: 1 },
    { op: "local.get", index: 1 },
    { op: "array.get", typeIdx: f.argumentsPack.array.typeIndex },
  ]);
  const exports = {
    ...controls,
    isCallable: adapter("js.function.is-callable"),
    init: adapter("js.function.init"),
    construct1: adapter("js.function.construct:1"),
    hasInstance: adapter("js.function.has-instance"),
    bindThis: adapter("js.function.this"),
    functionPrototype: kernel.entries[0]!.getter,
    objectPrototype: kernel.functions.objectPrototype,
    boxNumber: f.values.functions.boxNumber,
    unboxNumber: f.values.functions.unboxNumber,
    createDefault: f.storage.createDefault,
    match: kernel.functions.match,
    getPrototypeOf: kernel.functions.getPrototypeOf,
    get: kernel.functions.get,
    ownKeys: kernel.functions.ownKeys,
    ownDescriptor: kernel.functions.ownDescriptor,
    writeOwn: kernel.functions.writeOwn,
    currentThis: invocation.globals.currentThis,
    exception: kernel.exception,
  };
  for (const [name, token] of Object.entries(exports)) tx.defineExport("export:" + name, name, token);
  tx.seal();
  const compiled = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  if (WebAssembly.Module.imports(compiled).length !== 0) throw Error("function-object adapters import a host provider");
  return new WebAssembly.Instance(compiled).exports as unknown as FunctionObjectRuntime;
}
