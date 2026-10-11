// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import { preparedIrDataMismatch } from "../src/ir/program/data.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import type { IrUnitId } from "../src/shared/contracts/ir-identity.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { irUnitCallableBindingId } from "../src/ir/core/callable-bindings.js";
import { PhysicalModuleReservations, type FunctionReservation } from "../src/wasm/physical/module-reservations.js";
import { deriveNativeValueResourcePlan } from "../src/ir/program/native-value-resources.js";
import { deriveNativeVectorResourcePlan } from "../src/ir/program/native-vector-resources.js";
import { deriveNativeObjectAccessRequirements } from "../src/ir/program/native-object-access-requirements.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import { reserveNativeVectorTypes } from "../src/backend/wasmgc/resources/native-vectors.js";
import {
  beginNativeSourceClosureEmission,
  bindNativeSourceClosureUnits,
  nativeSourceClosureCallableBindings,
  nativeSourceClosureResolver,
  fillPreparedPrimaryUnit,
  requireCompletedNativeSourceClosures,
} from "../src/ir/program-native-invocation.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";
import {
  reserveNativeStringEqualityResources,
  fillNativeStringEqualityResources,
} from "../src/backend/wasmgc/resources/native-string-equality.js";
import {
  reserveNativeStringNumberResources,
  fillNativeStringNumberResources,
} from "../src/backend/wasmgc/resources/native-string-number.js";
import {
  reserveNativeValueResources,
  fillNativeValueResources,
} from "../src/backend/wasmgc/resources/native-values.js";
import {
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
} from "../src/backend/wasmgc/resources/native-booleans.js";
import {
  declareNativeBigIntResources,
  reserveNativeBigIntResources,
  fillNativeBigIntResources,
} from "../src/backend/wasmgc/resources/native-bigint.js";
import {
  reserveNativeSymbolCarrierResources,
  fillNativeSymbolCarrierResources,
} from "../src/backend/wasmgc/resources/native-symbol-carrier.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../src/backend/wasmgc/resources/native-object-layouts.js";
import { declareNativeObjectLookupResources } from "../src/backend/wasmgc/resources/native-object-access-declarations.js";
import {
  reserveNativeObjectLookupResources,
  fillNativeObjectLookupResources,
} from "../src/backend/wasmgc/resources/native-object-access.js";
import {
  declareNativeObjectStorageResources,
  reserveNativeObjectStorageResources,
  fillNativeObjectStorageResources,
} from "../src/backend/wasmgc/resources/native-object-storage.js";
import {
  declareNativeObjectSameValueResources,
  reserveNativeObjectSameValueResources,
  fillNativeObjectSameValueResources,
} from "../src/backend/wasmgc/resources/native-object-same-value.js";
import {
  reserveNativeErrorResources,
  fillNativeErrorResources,
} from "../src/backend/wasmgc/resources/native-errors.js";
import {
  NATIVE_OBJECT_DESCRIPTOR_LITERALS,
  declareNativeObjectDescriptorResources,
  reserveNativeObjectDescriptorResources,
  fillNativeObjectDescriptorResources,
  requireCompletedNativeObjectDescriptors,
} from "../src/backend/wasmgc/resources/native-object-descriptors.js";
import {
  reserveNativeInvocationResources,
  fillNativeInvocationResources,
  nativeInvocationGetterDispatch,
} from "../src/backend/wasmgc/resources/native-invocation.js";
import {
  declareNativeObjectGetResources,
  reserveNativeObjectGetResources,
  requireNativeObjectGetReservations,
  fillNativeObjectGetResources,
  requireCompletedNativeObjectGet,
  type NativeObjectGetDependencies,
} from "../src/backend/wasmgc/resources/native-object-get.js";
import { buildOrdinaryObjectGetDefinition } from "../src/runtime/wasmgc/values/ordinary-object-access-bodies.js";
import { getterRequirements, prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";

const SOURCE = `export function run(seed: number): number {
  const captured = seed;
  const object = { get value(): number {
    if (captured < 0) throw 99;
    return captured + 4;
  } };
  return object.value;
}`;
const RECEIVER_SOURCE =
  "export function run(): number { const object = { marker: 7, get value(): number { return this.marker; } }; return object.value; }";
const ext: ValType = { kind: "externref" },
  i32: ValType = { kind: "i32" },
  f64: ValType = { kind: "f64" };
let original: PreparedIrProgram;
beforeAll(() => {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  original = prepareGetterProgram(SOURCE);
});
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
afterAll(() => vi.unstubAllEnvs());

function sourceOracle(text = SOURCE): (value: number) => number {
  const exports: { run?: (value: number) => number } = {};
  runInNewContext(
    ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    { exports },
    { timeout: 1000 },
  );
  if (!exports.run) throw Error("source oracle has no run");
  return exports.run;
}

/** No imported runtime callbacks: all providers are issued by the real same-ledger owners. */
function fixture(program = original, offset = false) {
  const input = getterRequirements(program);
  if (!input.invocation) throw Error("actual source lost getter invocation requirements");
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const prefix = offset ? tx.reserveFunction("prefix", "prefix", { params: [], results: [i32] }) : undefined;
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage: offset,
    literals: [
      ...new Set([
        "",
        "TypeError",
        "Value is not callable",
        "value",
        "other",
        "missing",
        ...NATIVE_OBJECT_DESCRIPTOR_LITERALS,
      ]),
    ].map((value) => ({ value, encoding: "wtf16" as const })),
  });
  const flatten = reserveNativeStringFlattenResources(tx, "flatten", strings);
  const equality = reserveNativeStringEqualityResources(tx, "equality", flatten, true);
  const valuePlan = deriveNativeValueResourcePlan(program, input.projection, "native-string");
  const scanner = reserveNativeStringNumberResources(tx, valuePlan, flatten);
  const valueDependencies = { strings: { kind: "native-string" as const, stringPack: strings, scanner } };
  const values = reserveNativeValueResources(tx, valuePlan, valueDependencies);
  const vectorPlan = deriveNativeVectorResourcePlan({
    anchor: valuePlan.anchor,
    functions: input.projection.prepared.functions,
    abiEntries: program.abi.entries,
    policy: input.projection.prepared.manifest.policy,
    providers: input.projection.prepared.manifest.providers,
    backend: "wasmgc",
    target: "standalone",
  });
  const vectors = reserveNativeVectorTypes(tx, vectorPlan);
  const sourceOwner = beginNativeSourceClosureEmission(tx, input.source, { vectors, vectorPlan });
  const invocationDependencies = {
    source: sourceOwner.types,
    values,
    valuePlan,
    valueDependencies,
    strings,
    vectors,
    vectorPlan,
  };
  const invocation = reserveNativeInvocationResources(tx, input.invocation, invocationDependencies);
  const slots = new Map<IrUnitId, FunctionReservation>();
  const signatures = new Map<IrUnitId, { params: ValType[]; results: ValType[] }>();
  for (const unit of input.source.units) {
    const shape = input.source.shapes.find((row) => row.id === unit.shapeId)!;
    const binding = sourceOwner.types.closures.signatures.find((row) => row.id === shape.signatureId)!.binding;
    const signature = {
      params: [{ kind: "ref" as const, typeIdx: binding.liftedSelfTypeIndex }, ...binding.info.paramTypes],
      results: binding.info.returnType ? [binding.info.returnType] : [],
    };
    const fn = input.projection.prepared.functions.find((row) => row.unitId === unit.unitId)!;
    slots.set(unit.unitId, tx.reserveFunction(irUnitCallableBindingId(unit.unitId), fn.name, signature));
    signatures.set(unit.unitId, signature);
  }
  const booleans = reserveNativeBooleanResources(tx, "booleans", values, valuePlan, valueDependencies);
  const bigintPlan = declareNativeBigIntResources("bigints");
  const bigints = reserveNativeBigIntResources(tx, "bigints", bigintPlan);
  const symbols = reserveNativeSymbolCarrierResources(tx, "symbols", strings);
  const layoutRequirements = { key: "objects" },
    layoutPlan = declareNativeObjectLayouts(layoutRequirements);
  const layouts = reserveNativeObjectLayouts(tx, layoutRequirements, layoutPlan);
  const types = { object: layouts.object.key, propEntry: layouts.propEntry.key, nativeString: "strings:flat" };
  const lookupDependencies = { layouts, layoutPlan, strings, flatten, equality, symbols };
  const lookup = reserveNativeObjectLookupResources(
    tx,
    "lookup",
    lookupDependencies,
    declareNativeObjectLookupResources("lookup", types),
  );
  const storageDependencies = { lookup, lookupDependencies };
  const storage = reserveNativeObjectStorageResources(
    tx,
    "storage",
    storageDependencies,
    declareNativeObjectStorageResources("storage", layouts.object.key),
  );
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
  const sameValue = reserveNativeObjectSameValueResources(
    tx,
    "same-value",
    sameValueDependencies,
    declareNativeObjectSameValueResources("same-value"),
  );
  const errorRequirements = { key: "descriptor-errors" },
    errorDependencies = { strings, typeErrorTag: -11 };
  const errors = reserveNativeErrorResources(tx, errorRequirements, errorDependencies);
  const descriptorDependencies = {
    access: input.access,
    storage,
    storageDependencies,
    sameValue,
    sameValueDependencies,
    errors,
    errorRequirements,
    errorDependencies,
    closures: sourceOwner.types.closures,
  };
  const descriptors = reserveNativeObjectDescriptorResources(
    tx,
    "descriptors",
    descriptorDependencies,
    declareNativeObjectDescriptorResources("descriptors"),
  );
  const exception = tx.reserveTag("exception", { params: [ext], results: [] }, { kind: "defined", name: "__exn" });
  const dependencies: NativeObjectGetDependencies = {
    access: input.access,
    lookup,
    lookupDependencies,
    invocation,
    invocationRequirements: input.invocation,
    invocationDependencies,
  };
  const plan = structuredClone(declareNativeObjectGetResources("get", types));
  const get = reserveNativeObjectGetResources(tx, "get", dependencies, plan);
  return {
    ...input,
    module,
    tx,
    prefix,
    strings,
    flatten,
    equality,
    scanner,
    valuePlan,
    valueDependencies,
    values,
    booleans,
    bigints,
    symbols,
    sourceOwner,
    invocation,
    invocationDependencies,
    slots,
    signatures,
    layouts,
    types,
    lookup,
    lookupDependencies,
    storage,
    sameValue,
    errors,
    descriptorDependencies,
    descriptors,
    exception,
    dependencies,
    plan,
    get,
  };
}
type Fixture = ReturnType<typeof fixture>;

function resolver(f: Fixture): IrLowerResolver {
  return {
    ...nativeSourceClosureResolver(f.tx, f.sourceOwner),
    resolveFunc(reference) {
      if (reference.binding.kind === "unit") {
        const slot = f.slots.get(reference.binding.unitId);
        if (slot) return slot.handle;
      }
      for (const [feature, token] of [
        ["js.number.box", f.values.functions.boxNumber],
        ["js.number.unbox", f.values.functions.unboxNumber],
      ] as const) {
        const provider = f.projection.prepared.providers.get(feature);
        if (
          provider?.implementation.kind === "runtime-callable" &&
          reference.binding.kind === "runtime" &&
          reference.binding.symbol === provider.implementation.symbol
        )
          return token.handle;
      }
      throw Error("unowned callable in source getter: " + reference.name);
    },
    resolveGlobal() {
      throw Error("unexpected source getter global");
    },
    resolveType() {
      throw Error("unexpected source getter nominal type");
    },
    internFuncType(type) {
      return f.tx.internFunctionType(type.params, type.results);
    },
    ensureExnTag() {
      return f.tx.physicalIndex(f.exception);
    },
  };
}
function fillSource(f: Fixture) {
  for (const [id, slot] of f.slots) {
    const fn = f.projection.prepared.functions.find((row) => row.unitId === id)!;
    fillPreparedPrimaryUnit(f.tx, fn, slot, f.signatures.get(id)!, resolver(f), "wasmgc", f.sourceOwner);
  }
  requireCompletedNativeSourceClosures(f.tx, f.sourceOwner);
}
interface FixturePhase {
  readonly name: string;
  readonly run: (f: Fixture) => void;
}
function dependencyPhases(sourceBodies = true): FixturePhase[] {
  let callables: ReturnType<typeof nativeSourceClosureCallableBindings>;
  const phases: FixturePhase[] = [
    {
      name: "frozen source slots",
      run(f) {
        const { tx } = f;
        tx.freezeReservations();
        bindNativeSourceClosureUnits(tx, f.sourceOwner, f.slots);
        callables = nativeSourceClosureCallableBindings(tx, f.sourceOwner, f.invocation.requirements);
        if (f.prefix) tx.fillFunction(f.prefix, { locals: [], body: [{ op: "i32.const", value: 123 }] });
      },
    },
    {
      name: "filled string resources",
      run(f) {
        const { tx } = f;
        fillNativeStringLiteralResources(tx, f.strings);
        fillNativeStringFlattenResources(tx, f.flatten);
        fillNativeStringEqualityResources(tx, f.equality);
        fillNativeStringNumberResources(tx, f.scanner);
      },
    },
    {
      name: "filled primitive resources",
      run(f) {
        const { tx } = f;
        fillNativeValueResources(tx, f.values, f.valueDependencies);
        fillNativeBooleanResources(tx, f.booleans);
        fillNativeBigIntResources(tx, f.bigints);
        fillNativeSymbolCarrierResources(tx, f.symbols);
      },
    },
    {
      name: "filled ordinary lookup and storage",
      run(f) {
        const { tx } = f;
        fillNativeObjectLookupResources(tx, f.lookup);
        fillNativeObjectStorageResources(tx, f.storage);
        fillNativeObjectSameValueResources(tx, f.sameValue);
      },
    },
    {
      name: "filled descriptor resources",
      run(f) {
        const { tx } = f;
        fillNativeErrorResources(tx, f.errors);
        fillNativeObjectDescriptorResources(tx, f.descriptors, f.exception);
        requireCompletedNativeObjectDescriptors(tx, f.descriptors, f.descriptorDependencies);
      },
    },
    {
      name: "filled invocation resources",
      run(f) {
        fillNativeInvocationResources(f.tx, f.invocation, callables, f.exception);
      },
    },
  ];
  if (sourceBodies) phases.push({ name: "lowered actual source getters", run: fillSource });
  return phases;
}
function fillDependencies(f: Fixture, sourceBodies = true) {
  for (const phase of dependencyPhases(sourceBodies)) phase.run(f);
}
function complete(f: Fixture) {
  fillDependencies(f);
  fillNativeObjectGetResources(f.tx, f.get);
  return requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies);
}

function describeFixturePhases(phases: readonly FixturePhase[], fixture: () => Fixture, tests: () => void): void {
  const [phase, ...rest] = phases;
  if (!phase) {
    tests();
    return;
  }
  describe(phase.name, () => {
    beforeAll(() => phase.run(fixture()), 35_000);
    describeFixturePhases(rest, fixture, tests);
  });
}

/** Fresh setup per row; related CI timings justify phase bounds, not a larger timeout or cached authority. */
function phasedGetTest(
  title: string,
  sourceBodies: "before-get" | "after-get" | "missing",
  test: (f: Fixture) => void,
): void {
  describe("independent real Get lifecycle", () => {
    let f: Fixture;
    beforeAll(() => {
      f = fixture();
    }, 35_000);
    const phases = dependencyPhases(sourceBodies === "before-get");
    phases.push({ name: "filled canonical Get", run: (f) => fillNativeObjectGetResources(f.tx, f.get) });
    if (sourceBodies === "after-get") phases.push({ name: "lowered actual source getters", run: fillSource });
    describeFixturePhases(
      phases,
      () => f,
      () => it(title, () => test(f)),
    );
  });
}

interface Runtime {
  create(): unknown;
  createDefault(): unknown;
  withPrototype(parent: unknown): unknown;
  make(capture: number): unknown;
  key(): unknown;
  other(): unknown;
  missing(): unknown;
  undefinedValue(): unknown;
  box(value: number): unknown;
  unbox(value: unknown): number;
  defineData(object: unknown, key: unknown, value: unknown, flags: number): void;
  defineAccessor(object: unknown, key: unknown, getter: unknown, setter: unknown, flags: number): void;
  get(object: unknown, key: unknown, originalReceiver: unknown): [number, unknown];
  has(object: unknown, key: unknown): number;
  currentThis: WebAssembly.Global;
  argc: WebAssembly.Global;
  exception: WebAssembly.Tag;
}
function reserveRuntimeObservers(f: Fixture) {
  const { tx } = f;
  const signatures: Record<string, { params: ValType[]; results: ValType[] }> = {
    make: { params: [f64], results: [ext] },
    get: { params: [ext, ext, ext], results: [i32, ext] },
    has: { params: [ext, ext], results: [i32] },
    withPrototype: { params: [ext], results: [ext] },
    key: { params: [], results: [ext] },
    other: { params: [], results: [ext] },
    missing: { params: [], results: [ext] },
  };
  return Object.fromEntries(
    Object.entries(signatures).map(([name, signature]) => [
      name,
      tx.reserveFunction("observer:" + name, name, signature),
    ]),
  );
}
/** Boundary observers call the real owner; none stands in for lookup, descriptors, or dispatch. */
function runtime(f: Fixture, observers: ReturnType<typeof reserveRuntimeObservers>): Runtime {
  const { tx } = f;
  const fill = (name: string, body: Instr[]) => tx.fillFunction(observers[name]!, { locals: [], body });
  const use = f.invocation.requirements.getterUses[0]!;
  const shape = f.sourceOwner.types.shapes.find((row) => row.id === use.shapeId)!;
  const captureTypes = f.source.shapes.find((row) => row.id === use.shapeId)!.captures;
  expect(preparedIrDataMismatch(captureTypes, [{ kind: "val", val: f64 }])).toBeUndefined();
  const emitter = new WasmGcEmitter(resolver(f)),
    make: Instr[] = [];
  emitter.emitFuncRef(f.slots.get(use.liftedUnitId)!.handle, make);
  emitter.emitClosureArityOperand(0, make);
  make.push({ op: "local.get", index: 0 });
  emitter.emitClosureNew(shape.lowering, 1, make);
  emitter.emitToExternref(make);
  fill("make", make);
  const object = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.layouts.object.typeIndex },
  ];
  fill("get", [
    ...object(),
    { op: "local.get", index: 1 },
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: f.get.get.handle },
  ]);
  fill("has", [...object(), { op: "local.get", index: 1 }, { op: "call", funcIdx: f.lookup.has.handle }]);
  fill("withPrototype", [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast_null", typeIdx: f.layouts.object.typeIndex },
    { op: "call", funcIdx: f.storage.createWithPrototype.handle },
  ]);
  for (const [name, text] of [
    ["key", "value"],
    ["other", "other"],
    ["missing", "missing"],
  ] as const) {
    const ref = requireNativeStringLiteral(tx, f.strings, text);
    fill(name, [
      ref.kind === "global"
        ? { op: "global.get", index: tx.physicalIndex(ref.global) }
        : { op: "call", funcIdx: ref.function.handle },
      { op: "extern.convert_any" },
    ]);
  }
  const exported = {
    ...observers,
    ...f.descriptors,
    create: f.storage.createNull,
    createDefault: f.storage.createDefault,
    box: f.values.functions.boxNumber,
    unbox: f.values.functions.unboxNumber,
    undefinedValue: f.invocation.undefinedValue,
    currentThis: f.invocation.globals.currentThis,
    argc: f.invocation.globals.argc,
    exception: f.exception,
  };
  for (const [name, token] of Object.entries(exported)) tx.defineExport("export:" + name, name, token);
  requireCompletedNativeObjectGet(tx, f.get, f.dependencies);
  tx.seal();
  const module = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  expect(WebAssembly.Module.imports(module)).toStrictEqual([]);
  return new WebAssembly.Instance(module).exports as unknown as Runtime;
}

/** Preserve compiler records' prototypes and native contents without invoking accessors. */
function snapshotData<T>(input: T) {
  const copies = new Map<object, object>();
  const pairs: [object, object][] = [];
  const clone = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    if (copies.has(value)) return copies.get(value);
    let copy: object;
    if (value instanceof Map) copy = new Map();
    else if (value instanceof Set) copy = new Set();
    else if (value instanceof ArrayBuffer) copy = value.slice(0);
    else if (value instanceof Uint8Array)
      copy = new Uint8Array(clone(value.buffer) as ArrayBuffer, value.byteOffset, value.byteLength);
    else if (ArrayBuffer.isView(value)) throw Error("unsupported snapshot view");
    else copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    Object.setPrototypeOf(copy, Object.getPrototypeOf(value));
    copies.set(value, copy);
    pairs.push([value, copy]);
    return copy;
  };
  const data = clone(input) as T;
  // Queue traversal preserves cycles through collection entries, own fields, and buffer aliases.
  for (const [value, copy] of pairs) {
    if (value instanceof Map)
      for (const [key, entry] of value) (copy as Map<unknown, unknown>).set(clone(key), clone(entry));
    if (value instanceof Set) for (const entry of value) (copy as Set<unknown>).add(clone(entry));
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (Object.hasOwn(descriptor, "value")) descriptor.value = clone(descriptor.value);
      Object.defineProperty(copy, key, descriptor);
    }
  }
  return { data, prototypes: pairs.map(([value]) => Object.getPrototypeOf(value)) };
}
function unchangedData(value: unknown, action: () => void) {
  const before = snapshotData(value);
  action();
  const after = snapshotData(value);
  expect(after.prototypes).toHaveLength(before.prototypes.length);
  expect(after.prototypes.every((prototype, index) => Object.is(prototype, before.prototypes[index]))).toBe(true);
  expect(after.data).toStrictEqual(before.data);
}
function unchanged(f: Fixture, action: () => void) {
  unchangedData(f.module, action);
}
function mutableProgram() {
  const projection = {
    ...original.runtime[0]!,
    prepared: { ...original.runtime[0]!.prepared, functions: structuredClone(original.runtime[0]!.prepared.functions) },
  };
  return {
    ...original,
    ir: { ...original.ir, functions: structuredClone(original.ir.functions) },
    allocations: structuredClone(original.allocations),
    runtime: [projection],
  };
}

function snapshotControl() {
  const shared = Object.assign(Object.create(null), { value: 7 }) as { value: number };
  const buffer = new ArrayBuffer(8);
  const value = {
    shared,
    alias: shared,
    buffer,
    bytes: new Uint8Array(buffer, 2, 3),
    view: new Uint8Array(buffer, 1, 4),
    map: new Map<unknown, unknown>(),
    set: new Set<unknown>(),
    self: undefined as unknown,
  };
  value.bytes.set([3, 4, 5]);
  value.self = value;
  value.map.set(shared, value);
  value.set.add(shared).add(value);
  return value;
}
describe("physical-module snapshot controls", () => {
  it("preserves prototypes, collection contents, buffer aliases, and cycles", () => {
    const value = snapshotControl();
    const copy = snapshotData(value).data;
    unchangedData(value, () => {});
    expect(copy).toStrictEqual(value);
    expect(Object.is(copy, value)).toBe(false);
    expect(Object.getPrototypeOf(copy.shared)).toBeNull();
    expect(Object.is(copy.shared, value.shared)).toBe(false);
    expect(copy.alias).toBe(copy.shared);
    expect(copy.self).toBe(copy);
    expect(copy.map.get(copy.shared)).toBe(copy);
    expect(copy.set.has(copy.shared) && copy.set.has(copy)).toBe(true);
    expect(copy.bytes.buffer).toBe(copy.buffer);
    expect(copy.view.buffer).toBe(copy.buffer);
    expect(Object.is(copy.buffer, value.buffer)).toBe(false);
    expect([...copy.bytes]).toStrictEqual([3, 4, 5]);
  });
  it.each([
    [
      "data",
      (value: ReturnType<typeof snapshotControl>) => {
        value.shared.value++;
      },
    ],
    [
      "prototype with the same constructor",
      (value: ReturnType<typeof snapshotControl>) => {
        Object.setPrototypeOf(value, { changed: true });
      },
    ],
    [
      "Map entry",
      (value: ReturnType<typeof snapshotControl>) => {
        value.map.set(value.shared, null);
      },
    ],
    [
      "Set member",
      (value: ReturnType<typeof snapshotControl>) => {
        value.set.delete(value.shared);
      },
    ],
    [
      "typed-array bytes",
      (value: ReturnType<typeof snapshotControl>) => {
        value.bytes[0] = 99;
      },
    ],
    [
      "alias",
      (value: ReturnType<typeof snapshotControl>) => {
        value.alias = Object.assign(Object.create(null), value.shared);
      },
    ],
    [
      "cycle",
      (value: ReturnType<typeof snapshotControl>) => {
        value.self = value.shared;
      },
    ],
  ] as const)("detects a changed %s after its unchanged positive", (_name, mutate) => {
    const value = snapshotControl();
    unchangedData(value, () => {});
    expect(() => unchangedData(value, () => mutate(value))).toThrow();
  });
});

describe("issued internal ordinary Get ownership", () => {
  it("reserves only the canonical three-state Get ABI and retains all access gaps", () => {
    const f = fixture();
    expect(f.plan.declarations).toHaveLength(1);
    const row = f.plan.declarations[0]!;
    expect(row).toMatchObject({
      space: "function",
      role: ["ordinary-object-access", "get"],
      signature: {
        params: [{ kind: "ref", typeKey: f.layouts.object.key }, ext, ext],
        results: [i32, ext],
      },
    });
    expect(f.get.requirements).toBe(f.access);
    expect(f.get.gaps).toBe(f.access.gaps);
    expect(f.get.gaps.length).toBeGreaterThan(0);
    expect(f.get.completionScope).toBe("ordinary-object-get-prerequisite");
    expect(f.invocation.requirements.uses).toHaveLength(0);
    expect(f.invocation.requirements.getterUses).toHaveLength(1);
    unchanged(f, () => expect(requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toBe(f.get));
  });
  phasedGetTest("uses the exact actual C2 method-zero slot and original-receiver operand", "before-get", (f) => {
    requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies);
    const dispatch = nativeInvocationGetterDispatch(f.tx, f.invocation, f.access);
    const expected = buildOrdinaryObjectGetDefinition({
      propEntryTypeIdx: f.layouts.propEntry.typeIndex,
      lookupIdx: f.lookup.lookup.handle,
      getterDispatchIdx: dispatch.handle,
      undefinedGlobalIdx: f.tx.physicalIndex(f.values.globals.undefined),
    });
    expect(f.get.get.object.locals).toStrictEqual(expected.locals);
    expect(f.get.get.object.body).toStrictEqual(expected.body);
    const accessor = f.get.get.object.body.find(
      (row) => row.op === "if" && row.then.some((i) => i.op === "call" && i.funcIdx === dispatch.handle),
    );
    if (accessor?.op !== "if") throw Error("actual Get omitted accessor dispatch");
    expect(accessor.then.slice(-5)).toStrictEqual([
      { op: "local.get", index: 2 },
      { op: "local.get", index: 5 },
      { op: "extern.convert_any" },
      { op: "call", funcIdx: dispatch.handle },
      { op: "return" },
    ]);
  });
  it.each(["copied", "forged"] as const)("rejects a %s Get owner after the original passes", (kind) => {
    const f = fixture();
    expect(requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toBe(f.get);
    const fake = kind === "copied" ? { ...f.get } : Object.assign(Object.create(null), f.get);
    unchanged(f, () =>
      expect(() => requireNativeObjectGetReservations(f.tx, fake, f.dependencies)).toThrow("foreign or copied owner"),
    );
  });
  it("rejects a cross-ledger owner with an independently valid pair", () => {
    const a = fixture(),
      b = fixture();
    expect(requireNativeObjectGetReservations(a.tx, a.get, a.dependencies)).toBe(a.get);
    expect(requireNativeObjectGetReservations(b.tx, b.get, b.dependencies)).toBe(b.get);
    unchanged(b, () =>
      expect(() => requireNativeObjectGetReservations(b.tx, a.get, a.dependencies)).toThrow("foreign or copied owner"),
    );
    expect(requireNativeObjectGetReservations(a.tx, a.get, a.dependencies)).toBe(a.get);
  });
  it("rejects copied expected dependencies despite equal valid construction data", () => {
    const f = fixture();
    unchanged(f, () =>
      expect(() => requireNativeObjectGetReservations(f.tx, f.get, { ...f.dependencies })).toThrow(
        "foreign expected dependencies",
      ),
    );
    expect(requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toBe(f.get);
  });
  it("keeps two real same-ledger Get owners and their expected dependency identities distinct", () => {
    const f = fixture(),
      dependencies = { ...f.dependencies };
    const other = reserveNativeObjectGetResources(
      f.tx,
      "other-get",
      dependencies,
      declareNativeObjectGetResources("other-get", f.types),
    );
    expect(other.get).not.toBe(f.get.get);
    expect(requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toBe(f.get);
    expect(requireNativeObjectGetReservations(f.tx, other, dependencies)).toBe(other);
    unchanged(f, () => {
      expect(() => requireNativeObjectGetReservations(f.tx, other, f.dependencies)).toThrow(
        "foreign expected dependencies",
      );
      expect(() => requireNativeObjectGetReservations(f.tx, { ...f.get, get: other.get }, f.dependencies)).toThrow(
        "foreign or copied owner",
      );
    });
    expect(requireNativeObjectGetReservations(f.tx, other, dependencies)).toBe(other);
  });
  it.each([
    "access",
    "lookup",
    "lookupDependencies",
    "invocation",
    "invocationRequirements",
    "invocationDependencies",
  ] as const)("rejects a copied %s before reserving any new resource", (role) => {
    const f = fixture(),
      dependencies = { ...f.dependencies, [role]: { ...f.dependencies[role] } };
    unchanged(f, () =>
      expect(() =>
        reserveNativeObjectGetResources(
          f.tx,
          "rejected",
          dependencies,
          declareNativeObjectGetResources("rejected", f.types),
        ),
      ).toThrow(),
    );
    expect(requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toBe(f.get);
  });
  it("rejects a different issued access pack for the same source", () => {
    const f = fixture(),
      access = deriveNativeObjectAccessRequirements(f.program, f.projection);
    expect(Object.is(access, f.access)).toBe(false);
    const requirements = planNativeInvocationRequirements(f.source, { utf8Storage: false, objectAccess: access });
    expect(requirements?.getterUses).toHaveLength(1);
    unchanged(f, () =>
      expect(() =>
        reserveNativeObjectGetResources(
          f.tx,
          "rejected",
          { ...f.dependencies, access },
          declareNativeObjectGetResources("rejected", f.types),
        ),
      ).toThrow("foreign expected object-access requirements"),
    );
  });
  it("rejects another issued invocation requirement identity without leaking a slot", () => {
    const f = fixture();
    const invocationRequirements = planNativeInvocationRequirements(f.source, {
      utf8Storage: false,
      objectAccess: f.access,
    })!;
    expect(Object.is(invocationRequirements, f.dependencies.invocationRequirements)).toBe(false);
    unchanged(f, () =>
      expect(() =>
        reserveNativeObjectGetResources(
          f.tx,
          "rejected",
          { ...f.dependencies, invocationRequirements },
          declareNativeObjectGetResources("rejected", f.types),
        ),
      ).toThrow("substituted expected invocation requirements"),
    );
  });
  it("rejects a genuine foreign invocation owner rather than accepting its matching signature", () => {
    const f = fixture(),
      other = fixture();
    const dependencies = {
      ...f.dependencies,
      invocation: other.invocation,
      invocationRequirements: other.invocation.requirements,
      invocationDependencies: other.invocationDependencies,
    };
    unchanged(f, () =>
      expect(() =>
        reserveNativeObjectGetResources(
          f.tx,
          "rejected",
          dependencies,
          declareNativeObjectGetResources("rejected", f.types),
        ),
      ).toThrow("foreign or copied invocation owner"),
    );
  });
  it("rejects a replaced retained dependency after a successful authentication", () => {
    const f = fixture();
    expect(requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toBe(f.get);
    Object.assign(f.dependencies, { lookupDependencies: { ...f.lookupDependencies } });
    unchanged(f, () =>
      expect(() => requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toThrow(
        "substituted dependency identity",
      ),
    );
  });
  it("rejects accessor-bearing dependency data without invoking it", () => {
    const f = fixture(),
      dependencies = { ...f.dependencies };
    let observed = 0;
    Object.defineProperty(dependencies, "access", {
      get() {
        observed++;
        return f.access;
      },
    });
    unchanged(f, () =>
      expect(() =>
        reserveNativeObjectGetResources(
          f.tx,
          "rejected",
          dependencies,
          declareNativeObjectGetResources("rejected", f.types),
        ),
      ).toThrow("dependencies require own data fields"),
    );
    expect(observed).toBe(0);
  });
  it.each(["capture", "receiver", "descriptor", "instruction identity"] as const)(
    "rejects stale actual %s provenance after a successful reservation and authentication",
    (kind) => {
      const f = fixture(mutableProgram());
      expect(requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toBe(f.get);
      const demand = f.access.getters[0]!;
      const index =
        kind === "receiver"
          ? demand.getOccurrence
          : kind === "descriptor"
            ? demand.definitionOccurrence
            : demand.allocationOccurrence;
      const occurrence = f.access.demands.occurrences[index]!,
        instruction = occurrence.instruction;
      if (kind === "instruction identity") {
        const buffer = f.access.demands.buffers[occurrence.bufferIndex]!;
        (buffer.instructions as unknown[])[occurrence.instructionIndex] = structuredClone(instruction);
      } else if (instruction.kind === "closure.new") Object.assign(instruction, { captures: [] });
      else if (instruction.kind === "call") {
        const args = [...instruction.args];
        args[2] = args[1]!;
        Object.assign(instruction, { args });
      } else throw Error("mutation missed its positive actual source occurrence");
      unchanged(f, () =>
        expect(() => requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toThrow(/stale|changed|detached/),
      );
    },
  );
  it.each(["scalar ABI", "extra declaration", "missing step"] as const)("preflights %s atomically", (kind) => {
    const f = fixture(),
      plan = structuredClone(declareNativeObjectGetResources("rejected", f.types));
    const declaration = plan.declarations[0]!;
    if (declaration.space !== "function") throw Error("control lost the Get declaration");
    if (kind === "scalar ABI") Object.assign(declaration.signature, { results: [ext] });
    else if (kind === "extra declaration")
      Object.assign(plan, { declarations: [...plan.declarations, { ...declaration, key: "extra" }] });
    else Object.assign(plan, { reservationSteps: [] });
    unchanged(f, () => expect(() => reserveNativeObjectGetResources(f.tx, "rejected", f.dependencies, plan)).toThrow());
    expect(requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toBe(f.get);
  });
  it("rejects an accessor-bearing declaration without calling it or allocating a slot", () => {
    const f = fixture(),
      plan = structuredClone(declareNativeObjectGetResources("rejected", f.types));
    let observed = 0;
    Object.defineProperty(plan, "declarations", {
      get() {
        observed++;
        return [];
      },
    });
    unchanged(f, () =>
      expect(() => reserveNativeObjectGetResources(f.tx, "rejected", f.dependencies, plan)).toThrow(
        "non-data recipe field",
      ),
    );
    expect(observed).toBe(0);
  });
  it("rejects a changed retained declaration plan", () => {
    const f = fixture();
    expect(requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toBe(f.get);
    Object.assign(f.plan.declarations[0]!, { name: "changed" });
    unchanged(f, () =>
      expect(() => requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toThrow("changed declaration plan"),
    );
  });
  it("rejects a duplicate resource key before any reservation changes", () => {
    const f = fixture();
    unchanged(f, () =>
      expect(() => reserveNativeObjectGetResources(f.tx, "get", f.dependencies, f.plan)).toThrow(/duplicate|already/),
    );
  });
});

describe("ordinary Get canonical fill and completion", () => {
  it("refuses fill before freeze and completion without canonical fill", () => {
    const f = fixture();
    unchanged(f, () => expect(() => fillNativeObjectGetResources(f.tx, f.get)).toThrow("invalid phase"));
    unchanged(f, () =>
      expect(() => requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies)).toThrow("missing canonical fill"),
    );
  });
  it("does not fill against incomplete lookup/value resources", () => {
    const f = fixture();
    f.tx.freezeReservations();
    unchanged(f, () => expect(() => fillNativeObjectGetResources(f.tx, f.get)).toThrow(/missing|incomplete/));
    expect(f.get.get.object.body).toStrictEqual([]);
  });
  phasedGetTest(
    "permits graph filling but refuses completion until actual source getter bodies are lowered",
    "missing",
    (f) => {
      expect(f.get.get.object.body.length).toBeGreaterThan(0);
      expect(nativeInvocationGetterDispatch(f.tx, f.invocation, f.access).object.body.length).toBeGreaterThan(0);
      expect([...f.slots.values()].every((slot) => slot.object.body.length === 0)).toBe(true);
      expect(() => requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies)).toThrow("missing function fill");
      expect(f.tx.state).toBe("failed");
    },
  );
  phasedGetTest(
    "completes the paired fresh graph after actual source getter bodies are lowered",
    "after-get",
    (positive) => {
      // A failed physical transaction cannot be repaired or reused. Its paired positive is fresh.
      expect(requireCompletedNativeObjectGet(positive.tx, positive.get, positive.dependencies)).toBe(positive.get);
    },
  );
  phasedGetTest("refuses a duplicate canonical fill after the positive completed owner", "before-get", (f) => {
    expect(requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies)).toBe(f.get);
    unchanged(f, () => expect(() => fillNativeObjectGetResources(f.tx, f.get)).toThrow("duplicate canonical fill"));
    expect(requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies)).toBe(f.get);
  });
  for (const kind of ["get", "lookup", "dispatch", "source"] as const) {
    phasedGetTest(`rejects an already-filled ${kind} body mutation`, "before-get", (f) => {
      expect(requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies)).toBe(f.get);
      const token =
        kind === "get"
          ? f.get.get
          : kind === "lookup"
            ? f.lookup.lookup
            : kind === "dispatch"
              ? nativeInvocationGetterDispatch(f.tx, f.invocation, f.access)
              : [...f.slots.values()][0]!;
      token.object.body.push({ op: "nop" });
      expect(() => requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies)).toThrow("altered completed function");
    });
  }
  phasedGetTest("rejects replacement with a byte-equal filled Get body array", "before-get", (f) => {
    expect(requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies)).toBe(f.get);
    f.get.get.object.body = structuredClone(f.get.get.object.body);
    expect(() => requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies)).toThrow("altered completed function");
  });
  it("rejects an altered lookup carrier declaration", () => {
    const f = fixture();
    expect(requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toBe(f.get);
    Object.assign(f.layouts.propEntry.object, { name: "foreign-entry" });
    expect(() => requireNativeObjectGetReservations(f.tx, f.get, f.dependencies)).toThrow(/altered|changed|layout/);
  });
});

describe.each([false, true])("real descriptor → lookup → source getter, decoded/offset=%s", (decoded) => {
  let f: Fixture;
  let observers: ReturnType<typeof reserveRuntimeObservers>;
  let r: Runtime;
  beforeAll(() => {
    const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
    f = fixture(program, decoded);
    observers = reserveRuntimeObservers(f);
  }, 35_000);
  describe("completed real owner", () => {
    const phases = dependencyPhases();
    phases.push(
      { name: "filled canonical Get", run: (f) => fillNativeObjectGetResources(f.tx, f.get) },
      {
        name: "authenticated completed Get",
        run(f) {
          requireCompletedNativeObjectGet(f.tx, f.get, f.dependencies);
        },
      },
    );
    describeFixturePhases(
      phases,
      () => f,
      () => {
        describe("emitted module", () => {
          beforeAll(() => {
            r = runtime(f, observers);
          }, 35_000);
          it("returns the actual captured source getter value through installed descriptors", () => {
            const object = r.createDefault(),
              key = r.key();
            r.defineAccessor(object, key, r.make(3), null, 310);
            const [status, value] = r.get(object, key, object);
            expect(status).toBe(1);
            expect(r.unbox(value)).toBe(sourceOracle()(3));
            expect(r.unbox(value)).toBe(7);
          });
          it("walks multiple explicit prototypes and distinguishes inherited from overriding getters", () => {
            const parent = r.create(),
              child = r.withPrototype(parent),
              leaf = r.withPrototype(child),
              key = r.key();
            r.defineAccessor(parent, key, r.make(3), null, 310);
            expect(r.unbox(r.get(leaf, key, leaf)[1])).toBe(7);
            r.defineAccessor(child, key, r.make(8), null, 310);
            expect(r.unbox(r.get(leaf, key, leaf)[1])).toBe(12);
            expect(r.unbox(r.get(parent, key, leaf)[1])).toBe(7);
            expect(r.has(leaf, key)).toBe(1);
          });
          it("returns own data without invoking a throwing inherited getter", () => {
            const parent = r.create(),
              child = r.withPrototype(parent),
              key = r.key();
            r.defineAccessor(parent, key, r.make(-1), null, 310);
            const value = r.box(42);
            r.defineData(child, key, value, 191);
            const result = r.get(child, key, child);
            expect(result[0]).toBe(1);
            expect(result[1]).toBe(value);
            expect(r.unbox(result[1])).toBe(42);
          });
          it("propagates the original thrown source value and restores invocation state", () => {
            const parent = r.create(),
              child = r.withPrototype(parent),
              key = r.key(),
              previousThis = { previous: true };
            r.defineAccessor(parent, key, r.make(-1), null, 310);
            r.currentThis.value = previousThis;
            r.argc.value = 37;
            let actual: unknown, oracle: unknown;
            try {
              r.get(child, key, child);
            } catch (error) {
              actual = error;
            }
            try {
              sourceOracle()(-1);
            } catch (error) {
              oracle = error;
            }
            expect(oracle).toBe(99);
            expect(actual).toBeInstanceOf(WebAssembly.Exception);
            const exception = actual as WebAssembly.Exception;
            expect(exception.is(r.exception)).toBe(true);
            expect(r.unbox(exception.getArg(r.exception, 0))).toBe(oracle);
            expect(r.currentThis.value).toBe(previousThis);
            expect(r.argc.value).toBe(37);
          });
          it("restores caller state on successful real getter dispatch", () => {
            const object = r.create(),
              key = r.key(),
              previousThis = { previous: "normal" };
            r.defineAccessor(object, key, r.make(5), null, 310);
            r.currentThis.value = previousThis;
            r.argc.value = 23;
            const result = r.get(object, key, { distinctOriginalReceiver: true });
            expect(result[0]).toBe(1);
            expect(r.unbox(result[1])).toBe(9);
            expect(r.currentThis.value).toBe(previousThis);
            expect(r.argc.value).toBe(23);
          });
          it("does not invoke getters during Has", () => {
            const object = r.create(),
              key = r.key();
            r.defineAccessor(object, key, r.make(-1), null, 310);
            expect(r.has(object, key)).toBe(1);
            expect(r.has(object, r.missing())).toBe(0);
          });
          it("keeps present undefined distinct from an exhausted explicit null chain", () => {
            const object = r.create(),
              key = r.key(),
              undef = r.undefinedValue();
            r.defineData(object, key, undef, 191);
            expect(r.get(object, key, object)).toStrictEqual([1, undef]);
            expect(r.get(object, r.missing(), object)).toStrictEqual([0, undef]);
            expect(r.get(r.withPrototype(null), key, object)).toStrictEqual([0, undef]);
          });
          it("returns canonical undefined for an explicitly absent accessor getter", () => {
            const object = r.create(),
              key = r.key(),
              undef = r.undefinedValue();
            r.defineAccessor(object, key, undef, null, 310);
            expect(r.get(object, key, object)).toStrictEqual([1, undef]);
          });
          it("preserves needsImplicitPrototype through direct and inherited default tails", () => {
            const parent = r.createDefault(),
              child = r.withPrototype(parent),
              key = r.missing(),
              undef = r.undefinedValue();
            expect(r.get(parent, key, child)).toStrictEqual([2, undef]);
            expect(r.get(child, key, child)).toStrictEqual([2, undef]);
            expect(r.has(child, key)).toBe(2);
            const value = r.box(18);
            r.defineData(parent, key, value, 191);
            expect(r.get(child, key, child)).toStrictEqual([1, value]);
          });
        });
      },
    );
  });
});

describe("source and public-path limits retained", () => {
  it("retains the genuine receiver-observing source refusal beside its Node oracle", () => {
    expect(sourceOracle(RECEIVER_SOURCE)(0)).toBe(7);
    expect(() => prepareGetterProgram(RECEIVER_SOURCE)).toThrow(/'this' reference outside an instance method body/);
  });
});
