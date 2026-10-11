// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createEmptyModule } from "../../src/ir/types.js";
import { emitBinary } from "../../src/emit/binary.js";
import { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import { prepareWholeIrProgram } from "../../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../../src/ir/program-codec.js";
import { sourceInput } from "./typed-program-fixtures.js";
import { fillBigIntOperands, reserveBigIntOperands, type BigIntOperand } from "./native-bigint-carrier-fixture.js";
import { deriveNativeObjectAccessRequirements } from "../../src/ir/program/native-object-access-requirements.js";
import { deriveNativeValueResourcePlan } from "../../src/ir/program/native-value-resources.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
} from "../../src/backend/wasmgc/resources/native-values.js";
import {
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
} from "../../src/backend/wasmgc/resources/native-booleans.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../../src/backend/wasmgc/resources/native-bigint.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringEqualityResources,
  fillNativeStringEqualityResources,
} from "../../src/backend/wasmgc/resources/native-string-equality.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
} from "../../src/backend/wasmgc/resources/native-string-number.js";
import {
  reserveNativeSymbolCarrierResources,
  fillNativeSymbolCarrierResources,
} from "../../src/backend/wasmgc/resources/native-symbol-carrier.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../../src/backend/wasmgc/resources/native-object-layouts.js";
import { declareNativeObjectLookupResources } from "../../src/backend/wasmgc/resources/native-object-access-declarations.js";
import {
  reserveNativeObjectLookupResources,
  fillNativeObjectLookupResources,
} from "../../src/backend/wasmgc/resources/native-object-access.js";
import {
  declareNativeObjectStorageResources,
  reserveNativeObjectStorageResources,
  fillNativeObjectStorageResources,
} from "../../src/backend/wasmgc/resources/native-object-storage.js";
import {
  declareNativeObjectSameValueResources,
  reserveNativeObjectSameValueResources,
  fillNativeObjectSameValueResources,
} from "../../src/backend/wasmgc/resources/native-object-same-value.js";
import {
  reserveNativeErrorResources,
  fillNativeErrorResources,
} from "../../src/backend/wasmgc/resources/native-errors.js";
import { reserveNativeClosureResources } from "../../src/backend/wasmgc/resources/native-closures.js";
import { buildBuiltinClosureValueInstrs } from "../../src/runtime/wasmgc/values/closure-layouts.js";
import {
  NATIVE_OBJECT_DESCRIPTOR_LITERALS,
  declareNativeObjectDescriptorResources,
  reserveNativeObjectDescriptorResources,
  fillNativeObjectDescriptorResources,
  requireCompletedNativeObjectDescriptors,
} from "../../src/backend/wasmgc/resources/native-object-descriptors.js";

export const GETTER_SOURCE =
  "export function run() {const object = {get value() {return 7;}, set value(value: number) {}}; return object.value;}";
let cached: ReturnType<typeof sourceProgram> | undefined;
function sourceProgram() {
  const policy = {
    backend: "wasmgc",
    target: "standalone",
    numberBoundary: { box: "unsupported", unbox: "native" },
    stringConst: { storage: "native" },
  } as const;
  const result = prepareWholeIrProgram({
    ...sourceInput({ "./entry.ts": GETTER_SOURCE }),
    policy,
    runtimePolicies: [policy],
    nativeStringValueProjection: "standalone-native",
  });
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return result.program;
}
export function descriptorSource(decoded = false) {
  const original = (cached ??= sourceProgram());
  const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
  return { program, projection: program.runtime[0]! };
}
const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" },
  f64: ValType = { kind: "f64" };
export function descriptorFixture(offset = false) {
  const { program, projection } = descriptorSource();
  const access = deriveNativeObjectAccessRequirements(program, projection);
  const valuePlan = deriveNativeValueResourcePlan(program, projection, "native-string");
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  if (offset) {
    tx.reserveType("prefix:type", { kind: "struct", name: "Prefix", fields: [] });
    const prefix = tx.reserveFunction("prefix:function", "prefix", { params: [], results: [] });
    const global = tx.reserveGlobal("prefix:global", "prefix", i32, false);
    // Filled only after the shared freeze; no external imports or providers.
    prefixTokens.set(tx, { prefix, global });
  }
  const texts = [...new Set(["", "TypeError", "value", "other", "missing", ...NATIVE_OBJECT_DESCRIPTOR_LITERALS])];
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: offset,
    literals: texts.map((value) => ({ value, encoding: "wtf16" as const })),
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flatten", strings);
  const equality = reserveNativeStringEqualityResources(tx, "equality", flatten, true);
  const scanner = reserveNativeStringNumberResources(tx, valuePlan, flatten);
  const valueDependencies = { strings: { kind: "native-string" as const, stringPack: strings, scanner } };
  const values = reserveNativeValueResources(tx, valuePlan, valueDependencies);
  const booleans = reserveNativeBooleanResources(tx, "booleans", values, valuePlan, valueDependencies);
  const bigintPlan = declareNativeBigIntResources("bigints");
  const bigints = reserveNativeBigIntResources(tx, "bigints", bigintPlan);
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const layoutRequirements = { key: "objects" },
    layoutPlan = declareNativeObjectLayouts(layoutRequirements);
  const layouts = reserveNativeObjectLayouts(tx, layoutRequirements, layoutPlan);
  const lookupDependencies = { layouts, layoutPlan, strings, flatten, equality, symbols };
  const lookupPlan = declareNativeObjectLookupResources("lookup", {
    object: layouts.object.key,
    propEntry: layouts.propEntry.key,
    nativeString: "strings:flat",
  });
  const lookup = reserveNativeObjectLookupResources(tx, "lookup", lookupDependencies, lookupPlan);
  const storageDependencies = { lookup, lookupDependencies };
  const storagePlan = declareNativeObjectStorageResources("storage", layouts.object.key);
  const storage = reserveNativeObjectStorageResources(tx, "storage", storageDependencies, storagePlan);
  const sameValueDependencies = {
    values,
    valuePlan,
    valueDependencies,
    booleans,
    bigints,
    bigintPlan,
    strings,
    flatten,
    equality,
  };
  const sameValuePlan = declareNativeObjectSameValueResources("same-value");
  const sameValue = reserveNativeObjectSameValueResources(tx, "same-value", sameValueDependencies, sameValuePlan);
  const errorRequirements = { key: "errors" },
    errorDependencies = { strings, typeErrorTag: -11 };
  const errors = reserveNativeErrorResources(tx, errorRequirements, errorDependencies);
  const closures = reserveNativeClosureResources(tx, {
    key: "closures",
    startingClosureCounter: 0,
    referenceTypes: [],
    requests: [{ kind: "signature", id: "getter", params: [], results: [f64], allocationMode: "ordinary" }],
  });
  const dependencies = {
    access,
    storage,
    storageDependencies,
    sameValue,
    sameValueDependencies,
    errors,
    errorRequirements,
    errorDependencies,
    closures,
  };
  const plan = declareNativeObjectDescriptorResources("descriptors");
  const pack = reserveNativeObjectDescriptorResources(tx, "descriptors", dependencies, plan);
  const exception = tx.reserveTag("exception", { params: [ext], results: [] }, { kind: "defined", name: "exception" });
  return {
    module,
    tx,
    program,
    projection,
    access,
    valuePlan,
    strings,
    flatten,
    equality,
    scanner,
    valueDependencies,
    values,
    booleans,
    bigintPlan,
    bigints,
    symbols,
    layouts,
    lookup,
    lookupDependencies,
    storage,
    storageDependencies,
    sameValue,
    sameValueDependencies,
    sameValuePlan,
    errors,
    errorRequirements,
    errorDependencies,
    closures,
    dependencies,
    plan,
    pack,
    exception,
  };
}
const prefixTokens = new WeakMap<
  PhysicalModuleReservations,
  {
    prefix: ReturnType<PhysicalModuleReservations["reserveFunction"]>;
    global: ReturnType<PhysicalModuleReservations["reserveGlobal"]>;
  }
>();
export function fillDescriptorDependencies(f: ReturnType<typeof descriptorFixture>) {
  const prefix = prefixTokens.get(f.tx);
  if (prefix) {
    f.tx.fillFunction(prefix.prefix, { locals: [], body: [] });
    f.tx.fillGlobal(prefix.global, [{ op: "i32.const", value: 123 }]);
  }
  fillNativeStringLiteralResources(f.tx, f.strings);
  fillNativeStringFlattenResources(f.tx, f.flatten);
  fillNativeStringEqualityResources(f.tx, f.equality);
  fillNativeStringNumberResources(f.tx, f.scanner);
  fillNativeValueResources(f.tx, f.values, f.valueDependencies);
  fillNativeBooleanResources(f.tx, f.booleans);
  fillNativeBigIntResources(f.tx, f.bigints);
  fillNativeSymbolCarrierResources(f.tx, f.symbols);
  fillNativeObjectLookupResources(f.tx, f.lookup);
  fillNativeObjectStorageResources(f.tx, f.storage);
  fillNativeObjectSameValueResources(f.tx, f.sameValue);
  fillNativeErrorResources(f.tx, f.errors);
}
export function completeDescriptorFixture(f: ReturnType<typeof descriptorFixture>) {
  f.tx.freezeReservations();
  fillDescriptorDependencies(f);
  fillNativeObjectDescriptorResources(f.tx, f.pack, f.exception);
  requireCompletedNativeObjectDescriptors(f.tx, f.pack, f.dependencies);
}

export interface DescriptorRuntime extends Record<BigIntOperand, () => object> {
  create(): object;
  createDefault(): object;
  key(): object;
  other(): object;
  missing(): object;
  undefinedValue(): object;
  boxNumber(value: number): unknown;
  unboxNumber(value: unknown): number;
  boxBoolean(value: number): object;
  boxBigInt(value: bigint): object;
  readBigInt(value: unknown): bigint;
  isBigInt(value: unknown): number;
  sameValue(a: unknown, b: unknown): number;
  defineData(object: unknown, key: unknown, value: unknown, flags: number): void;
  defineAccessor(object: unknown, key: unknown, getter: unknown, setter: unknown, flags: number): void;
  defineAttributes(object: unknown, key: unknown, flags: number): void;
  entry(object: unknown, key: unknown): [number, unknown, unknown, unknown];
  has(object: unknown, key: unknown): number;
  objectFlags(object: unknown, flags: number): void;
  closure(): object;
  closureValue(value: unknown): number;
  exception: WebAssembly.Tag;
}
/** Execute genuine installed resources; observer wrappers grant no consumer/source acceptance. */
export function descriptorRuntime(offset = false): DescriptorRuntime {
  const f = descriptorFixture(offset),
    { tx } = f;
  const bigintOperands = reserveBigIntOperands(tx);
  const signatures: Record<string, { params: ValType[]; results: ValType[] }> = {
    key: { params: [], results: [ext] },
    other: { params: [], results: [ext] },
    missing: { params: [], results: [ext] },
    undefinedValue: { params: [], results: [ext] },
    boxBoolean: { params: [i32], results: [ext] },
    entry: { params: [ext, ext], results: [i32, ext, ext, ext] },
    has: { params: [ext, ext], results: [i32] },
    objectFlags: { params: [ext, i32], results: [] },
    closure: { params: [], results: [ext] },
    closureValue: { params: [ext], results: [f64] },
  };
  const observers = Object.fromEntries(
    Object.entries(signatures).map(([name, signature]) => [
      name,
      tx.reserveFunction("observer:" + name, name, signature),
    ]),
  );
  const getter = f.closures.signatures[0]!.binding;
  const lifted = tx.reserveFunction("observer:lifted", "lifted", {
    params: [{ kind: "ref", typeIdx: f.closures.root.typeIndex }],
    results: [f64],
  });
  completeDescriptorFixture(f);
  fillBigIntOperands(tx, f.bigints, bigintOperands);
  tx.fillFunction(lifted, { locals: [], body: [{ op: "f64.const", value: 7 }] });
  tx.declareFunctionReference(lifted);
  const fill = (name: string, body: Instr[]) => tx.fillFunction(observers[name]!, { locals: [], body });
  for (const [role, text] of [
    ["key", "value"],
    ["other", "other"],
    ["missing", "missing"],
  ] as const) {
    const ref = requireNativeStringLiteral(tx, f.strings, text);
    fill(role, [
      ref.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(ref.global) }
        : { op: "call", funcIdx: ref.function.handle },
      { op: "extern.convert_any" },
    ]);
  }
  fill("undefinedValue", [
    { op: "global.get", index: tx.physicalIndex(f.values.globals.undefined) },
    { op: "extern.convert_any" },
  ]);
  fill("boxBoolean", [
    { op: "local.get", index: 0 },
    { op: "struct.new", typeIdx: f.values.types.boxedBoolean.typeIndex },
    { op: "extern.convert_any" },
  ]);
  const object = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.layouts.object.typeIndex },
  ];
  const entry = (): Instr[] => [
    ...object(),
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: f.lookup.findOwn.handle },
    { op: "ref.as_non_null" },
  ];
  fill(
    "entry",
    [2, 1, 4, 5].flatMap((fieldIdx): Instr[] => [
      ...entry(),
      { op: "struct.get", typeIdx: f.layouts.propEntry.typeIndex, fieldIdx },
      ...(fieldIdx === 2 ? [] : [{ op: "extern.convert_any" } as Instr]),
    ]),
  );
  fill("has", [...object(), { op: "local.get", index: 1 }, { op: "call", funcIdx: f.lookup.has.handle }]);
  fill("objectFlags", [
    ...object(),
    { op: "local.get", index: 1 },
    { op: "struct.set", typeIdx: f.layouts.object.typeIndex, fieldIdx: 4 },
  ]);
  fill("closure", [
    ...buildBuiltinClosureValueInstrs(getter.type.typeIndex, lifted.handle, 0, false),
    { op: "extern.convert_any" },
  ]);
  const closure = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.closures.root.typeIndex },
  ];
  fill("closureValue", [
    ...closure(),
    ...closure(),
    { op: "struct.get", typeIdx: f.closures.root.typeIndex, fieldIdx: 0 },
    { op: "ref.cast", typeIdx: getter.liftedFuncTypeIndex },
    { op: "call_ref", typeIdx: getter.liftedFuncTypeIndex },
  ]);
  const exports = {
    ...observers,
    ...bigintOperands,
    ...f.pack,
    create: f.storage.createNull,
    createDefault: f.storage.createDefault,
    boxNumber: f.values.functions.boxNumber,
    unboxNumber: f.values.functions.unboxNumber,
    boxBigInt: f.bigints.box,
    readBigInt: f.bigints.read,
    isBigInt: f.bigints.isBigInt,
    sameValue: f.sameValue.sameValue,
    exception: f.exception,
  };
  for (const [name, token] of Object.entries(exports)) tx.defineExport("export:" + name, name, token);
  tx.seal();
  const module = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  if (WebAssembly.Module.imports(module).length)
    throw Error("descriptor resource execution unexpectedly imports providers");
  return new WebAssembly.Instance(module).exports as unknown as DescriptorRuntime;
}
