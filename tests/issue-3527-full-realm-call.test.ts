// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fullRealmFixture as fixture,
  joinFullRealm as join,
  fillFullRealm as fill,
} from "./helpers/native-full-realm-call.js";
import { fillFullRealmSourceUnits as fillSourceUnits } from "./helpers/native-full-realm-call.js";

import {
  reserveNativeObjectRealmCalls,
  fillNativeObjectRealmCalls,
  nativeObjectRealmInvocationBinding,
} from "../src/backend/wasmgc/resources/native-object-realm-calls.js";
import {
  bindNativeInvocationObjectRealm,
  nativeInvocationObjectRealmBinding,
  requireCompletedNativeInvocation,
  nativeInvocationCallableBinding,
} from "../src/backend/wasmgc/resources/native-invocation.js";
import {
  bindNativeMixedObjectInvocation,
  bindNativeMixedObjectPopulation,
  requireCompletedNativeMixedObjectAccessStructure,
  fillNativeMixedObjectGet,
  requireCompletedNativeMixedObjectAccess,
} from "../src/backend/wasmgc/resources/native-mixed-object-access.js";

import { requireNativeStringLiteral } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr } from "../src/wasm/model/instructions.js";

import {
  requireCompletedNativeRealmPopulation,
  reserveNativeRealmPopulation,
  fillNativeRealmPopulation,
} from "../src/backend/wasmgc/resources/native-realm-population.js";
import {
  reserveNativeRealmFunctionCore,
  fillNativeRealmFunctionCore,
  requireCompletedNativeRealmFunctionCore,
} from "../src/backend/wasmgc/resources/native-realm-function-core.js";
import {
  declareNativeNumberPrimitiveClassifierResources,
  reserveNativeNumberPrimitiveClassifierResources,
  fillNativeNumberPrimitiveClassifierResources,
} from "../src/backend/wasmgc/resources/native-number-primitive-classifier.js";
import {
  reserveNativeRealmNumberCoercion,
  fillNativeRealmNumberCoercion,
  requireCompletedNativeRealmNumberCoercion,
} from "../src/backend/wasmgc/resources/native-realm-number-coercion.js";
import {
  reserveNativeRyuResources,
  fillNativeRyuResources,
} from "../src/backend/wasmgc/resources/native-number-ryu.js";
import {
  reserveNativeDecimalFormat,
  fillNativeDecimalFormat,
} from "../src/backend/wasmgc/resources/native-decimal-format.js";
import {
  reserveNativeRealmFunctionApply,
  fillNativeRealmFunctionApply,
  requireCompletedNativeRealmFunctionApply,
} from "../src/backend/wasmgc/resources/native-realm-function-apply.js";
import { setImmediate } from "node:timers/promises";
// Long synchronous reservation audits can outlive Vitest's worker RPC timer.
// Let IPC responses drain before the next audit, including the first test.
async function drainWorkerEvents() {
  await setImmediate();
  await setImmediate();
}
beforeEach(drainWorkerEvents);
afterEach(drainWorkerEvents);

function reserveNumericClassifier(r: ReturnType<typeof fixture>) {
  const classifierDependencies = {
    values: r.values,
    valuePlan: r.valuePlan,
    valueDependencies: r.valueDependencies,
    booleans: r.booleans,
    bigints: r.population.bigints,
    bigintPlan: r.population.bigintPlan,
    strings: r.f.strings,
    symbols: r.symbols,
  };
  return reserveNativeNumberPrimitiveClassifierResources(
    r.tx,
    "control:classifier",
    declareNativeNumberPrimitiveClassifierResources("control:classifier"),
    classifierDependencies,
  );
}
describe("full public realm Call joins", { timeout: 240000 }, () => {
  it("rejects invalid numeric joins and late key collisions without reserving anything", () => {
    const r = fixture();
    join(r);
    const classifier = reserveNumericClassifier(r);
    const counts = () => [r.f.module.functions.length, r.f.module.types.length, r.f.module.globals.length];
    const initial = counts();
    expect(() => reserveNativeRealmNumberCoercion(r.tx, "invalid", r.invocation, r.access, { ...classifier })).toThrow(
      /foreign or copied/,
    );
    expect(counts()).toEqual(initial);
    expect(() => nativeInvocationCallableBinding(r.tx, r.invocation)).toThrow(/missing issued/);
    r.tx.reserveFunction("collision:length", "collision", { params: [], results: [] });
    const collision = counts();
    expect(() => reserveNativeRealmNumberCoercion(r.tx, "collision", r.invocation, r.access, classifier)).toThrow();
    expect(counts()).toEqual(collision);
    // Duplicate keys poison the transaction by design; no new resource was allocated.
    expect(r.tx.state).toBe("failed");
  });
  it("rejects copied, foreign and accessor dependencies before reservation", () => {
    const r = fixture(),
      before = r.f.module.functions.length;
    expect(() => nativeObjectRealmInvocationBinding(r.tx, { ...r.calls })).toThrow(/foreign or copied/);
    expect(() => reserveNativeRealmPopulation(r.tx, r.population.dependencies)).toThrow(/already has a population/);
    expect(() => requireCompletedNativeRealmPopulation(r.tx, { ...r.population.pack })).toThrow(/foreign or copied/);
    const copy = { ...r.dependencies };
    Object.defineProperty(copy, "values", {
      get() {
        throw Error("must not read getter");
      },
      enumerable: true,
    });
    expect(() => reserveNativeObjectRealmCalls(r.tx, "bad", copy)).toThrow(/own data/);
    expect(() => reserveNativeObjectRealmCalls(r.tx, "duplicate", r.dependencies)).toThrow(/already has a Call owner/);
    expect(r.f.module.functions.length).toBe(before);
    const other = fixture();
    expect(() => bindNativeMixedObjectPopulation(r.tx, r.access, { ...r.population.pack })).toThrow(
      /foreign or copied/,
    );
    expect(() => bindNativeMixedObjectPopulation(r.tx, r.access, other.population.pack)).toThrow(/foreign or copied/);
    expect(() => bindNativeInvocationObjectRealm(r.tx, r.invocation, other.calls)).toThrow(/foreign or copied/);
    expect(() => bindNativeMixedObjectInvocation(r.tx, r.access, r.invocation)).toThrow(/missing full public/);
    join(r);
    expect(nativeInvocationObjectRealmBinding(r.tx, r.invocation).realm).toBe(r.realm.declarations);
    expect(() => bindNativeInvocationObjectRealm(r.tx, r.invocation, r.calls)).toThrow(/duplicate/);
    expect(() => bindNativeMixedObjectInvocation(r.tx, r.access, r.invocation)).toThrow(/duplicate/);
    expect(() => bindNativeMixedObjectPopulation(r.tx, r.access, r.population.pack)).toThrow(/duplicate/);
  });
  it("refuses core completion from a caller-filled public dispatcher", async () => {
    const r = fixture();
    join(r);
    const core = reserveNativeRealmFunctionCore(r.tx, r.invocation);
    await fill(r, false);
    fillSourceUnits(r);
    for (const slot of [r.calls.match, r.calls.call, ...r.realm.declarations.entries.map((entry) => entry.lifted)])
      r.tx.fillFunction(slot, { locals: [], body: [{ op: "unreachable" }] });
    expect(() => fillNativeRealmFunctionCore(r.tx, core)).toThrow(/missing canonical dispatcher fill/);
    expect(() => requireCompletedNativeRealmFunctionCore(r.tx, core)).toThrow(/missing canonical core fill/);
  });
  it("detects dependency replacement and never grants complete realm authority from filled dispatch", async () => {
    const r = fixture();
    join(r);
    await fill(r);
    expect(() => nativeObjectRealmInvocationBinding(r.tx, r.calls, true)).toThrow(
      /full Object\/Function\/Promise algorithms/,
    );
    expect(() => fillNativeRealmPopulation(r.tx, r.population.pack)).toThrow(/duplicate/);
    expect(() => fillNativeObjectRealmCalls(r.tx, r.calls)).toThrow(/duplicate/);
    expect(() => fillNativeMixedObjectGet(r.tx, r.access)).toThrow(/duplicate/);
    const values = r.dependencies.values;
    r.dependencies.values = { ...r.values };
    expect(() => nativeObjectRealmInvocationBinding(r.tx, r.calls)).toThrow(/changed dependency/);
    r.dependencies.values = values;
    // The physical ledger rejects changed completed code and poisons the transaction.
    // Run this last; no later completion check may reuse that failed ledger.
    r.realm.declarations.initialize.object.body = [{ op: "unreachable" }];
    expect(() => requireCompletedNativeMixedObjectAccessStructure(r.tx, r.access)).toThrow(
      /altered completed function/,
    );
    expect(r.tx.state).toBe("failed");
  });
});

const ext = { kind: "externref" } as const;
const get = (index: number): Instr => ({ op: "local.get", index });
const global = (index: number): Instr => ({ op: "global.get", index });
const n = (value: number): Instr => ({ op: "i32.const", value });

/** The core and apply algorithms are real; remaining controls observe Call's receiver/argv without claiming builtin semantics. */
async function executable(displaced: boolean) {
  const r = fixture(displaced),
    { tx, f, c } = r,
    realm = r.realm.declarations;
  join(r);
  const core = reserveNativeRealmFunctionCore(tx, r.invocation);
  expect(() => reserveNativeRealmFunctionCore(tx, r.invocation)).toThrow(/already has/);
  expect(() => requireCompletedNativeRealmFunctionCore(tx, { ...core })).toThrow(/foreign or copied/);
  const classifier = reserveNumericClassifier(r);
  const coercion = reserveNativeRealmNumberCoercion(tx, "number-coercion", r.invocation, r.access, classifier);
  expect(() => requireCompletedNativeRealmNumberCoercion(tx, { ...coercion })).toThrow(/foreign or copied/);
  expect(() => requireCompletedNativeRealmNumberCoercion(tx, coercion)).toThrow(/missing canonical/);
  const ryu = reserveNativeRyuResources(tx, "apply:ryu", f.strings);
  const decimal = reserveNativeDecimalFormat(tx, "apply:decimal", f.strings, ryu);
  const beforeApply = f.module.functions.length;
  expect(() => reserveNativeRealmFunctionApply(tx, "bad-apply", r.invocation, { ...coercion }, decimal)).toThrow(
    /foreign or copied/,
  );
  expect(() => reserveNativeRealmFunctionApply(tx, "bad-apply", r.invocation, coercion, { ...decimal })).toThrow(
    /foreign or copied/,
  );
  expect(f.module.functions).toHaveLength(beforeApply);
  const apply = reserveNativeRealmFunctionApply(tx, "apply", r.invocation, coercion, decimal);
  expect(() => reserveNativeRealmFunctionApply(tx, "duplicate-apply", r.invocation, coercion, decimal)).toThrow(
    /already has/,
  );
  expect(() => requireCompletedNativeRealmFunctionApply(tx, { ...apply })).toThrow(/foreign or copied/);
  expect(() => requireCompletedNativeRealmFunctionApply(tx, apply)).toThrow(/missing canonical/);
  const implemented: readonly string[] = [...core.implemented, ...apply.implemented];
  const object = tx.reserveFunction("control:object", "object", { params: [ext], results: [ext] });
  const property = tx.reserveFunction("control:property", "property", {
    params: [ext, ext, ext, { kind: "i32" }],
    results: [],
  });
  const initialize = realm.initialize;
  const foreignClone = tx.reserveFunction("control:foreign-clone", "foreign_clone", { params: [ext], results: [ext] });
  const own = tx.reserveFunction("control:accessor", "accessor", { params: [ext], results: [ext] });
  const inspect = tx.reserveFunction("control:inspect", "inspect", {
    params: [ext, ext],
    results: [{ kind: "i32" }, { kind: "i32" }, ext, ext, ext],
  });
  const bag = tx.reserveFunction("control:bag", "bag", { params: [ext], results: [ext] });
  const argc = tx.reserveGlobal("control:argc", "argc", { kind: "i32" }, true);
  const getterMode = tx.reserveGlobal("control:getter-mode", "getter_mode", { kind: "i32" }, true);
  const trace = tx.reserveGlobal("control:trace", "trace", { kind: "i32" }, true);
  const lastArgs = tx.reserveGlobal("control:last-args", "last_args", ext, true);
  const argument = tx.reserveFunction("control:argument", "argument", { params: [{ kind: "i32" }], results: [ext] });
  await fill(r);
  fillSourceUnits(r);
  tx.fillFunction(foreignClone, {
    locals: [],
    body: [
      ...c.source!.types.shapes.flatMap((shape): Instr[] => {
        if (shape.type.object.kind !== "struct") throw Error("expected source struct");
        const typeIdx = shape.type.typeIndex;
        return [
          get(0),
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...shape.type.object.fields
                .slice(0, -1)
                .flatMap((_, fieldIdx): Instr[] => [
                  get(0),
                  { op: "any.convert_extern" },
                  { op: "ref.cast", typeIdx },
                  { op: "struct.get", typeIdx, fieldIdx },
                ]),
              { op: "ref.null.extern" },
              { op: "struct.new", typeIdx: realm.layouts.types.identity.typeIndex },
              { op: "struct.new", typeIdx: realm.layouts.types.state.typeIndex },
              { op: "struct.new", typeIdx },
              { op: "extern.convert_any" },
              { op: "return" },
            ],
          },
        ];
      }),
      { op: "unreachable" },
    ],
  });
  fillNativeNumberPrimitiveClassifierResources(tx, classifier);
  fillNativeRealmNumberCoercion(tx, coercion);
  requireCompletedNativeRealmNumberCoercion(tx, coercion);
  fillNativeRyuResources(tx, ryu);
  fillNativeDecimalFormat(tx, decimal);
  fillNativeRealmFunctionApply(tx, apply);
  expect(requireCompletedNativeRealmFunctionApply(tx, apply)).toBe(apply);
  expect(() => fillNativeRealmFunctionApply(tx, apply)).toThrow(/duplicate/);
  fillNativeRealmFunctionCore(tx, core);
  expect(requireCompletedNativeRealmFunctionCore(tx, core)).toBe(core);
  expect(() => fillNativeRealmFunctionCore(tx, core)).toThrow(/duplicate/);
  const literal = requireNativeStringLiteral(tx, f.strings, "name");
  if (literal.kind !== "global") throw Error("small fixture key not global");
  const key = [global(tx.physicalIndex(literal.global))];
  const prefix: Instr[] = [
    { op: "ref.null", typeIdx: f.objects.object.typeIndex },
    n(8),
    { op: "array.new_default", typeIdx: f.objects.propMap.typeIndex },
    n(0),
    n(0),
    n(128),
    n(0),
  ];
  const realmGlobal = tx.physicalIndex(realm.globals.realm);
  tx.fillGlobal(argc, [n(-1)]);
  tx.fillGlobal(getterMode, [n(0)]);
  tx.fillGlobal(trace, [n(0)]);
  tx.fillGlobal(lastArgs, [{ op: "ref.null.extern" }]);
  tx.fillFunction(argument, {
    locals: [],
    body: [
      global(tx.physicalIndex(lastArgs)),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: f.substrate.arguments.carrier.typeIndex },
      { op: "struct.get", typeIdx: f.substrate.arguments.carrier.typeIndex, fieldIdx: 1 },
      get(0),
      { op: "array.get", typeIdx: f.substrate.arguments.layout.objVecArrTypeIdx },
    ],
  });
  tx.fillFunction(object, {
    locals: [],
    body: [
      ...prefix,
      get(0),
      global(realmGlobal),
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: f.pack.types.state.typeIndex },
      { op: "struct.new", typeIdx: f.pack.types.ordinary.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  const objectRef: Instr[] = [
    get(0),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.objects.object.typeIndex },
  ];
  tx.fillFunction(property, {
    locals: [],
    body: [
      ...objectRef,
      get(1),
      get(2),
      { op: "any.convert_extern" },
      get(3),
      n(0),
      { op: "call", funcIdx: r.storage.insert.handle },
      get(3),
      n(8),
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...objectRef,
          get(1),
          { op: "call", funcIdx: r.lookup.findOwn.handle },
          { op: "ref.as_non_null" },
          get(2),
          { op: "any.convert_extern" },
          { op: "struct.set", typeIdx: f.objects.propEntry.typeIndex, fieldIdx: 4 },
        ],
      },
    ],
  });
  // Each native control reports the actual argument-vector length and returns its original receiver.
  // One control instead throws that exact receiver; unimplemented standard semantics gain no authority.
  realm.entries.forEach((entry, index) => {
    if (implemented.includes(entry.request.intrinsic.id)) return;
    tx.fillFunction(entry.algorithm, {
      locals: [],
      body: [
        get(1),
        { op: "struct.get", typeIdx: f.substrate.arguments.carrier.typeIndex, fieldIdx: 0 },
        { op: "global.set", index: tx.physicalIndex(argc) },
        get(1),
        { op: "extern.convert_any" },
        { op: "global.set", index: tx.physicalIndex(lastArgs) },
        global(tx.physicalIndex(getterMode)),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            global(tx.physicalIndex(trace)),
            n(10),
            { op: "i32.mul" },
            n(index),
            { op: "i32.add" },
            { op: "global.set", index: tx.physicalIndex(trace) },
            ...([4, 5, 6].includes(index)
              ? ([
                  { op: "f64.const", value: index === 4 ? 2 : index + 36 },
                  { op: "call", funcIdx: r.values.functions.boxNumber.handle },
                  { op: "return" },
                ] as Instr[])
              : []),
          ],
        },
        get(0),
        ...(index === 2 ? [{ op: "throw", tagIdx: tx.physicalIndex(f.exception.tag) } as Instr] : []),
      ],
    });
    if (entry.construct) tx.fillFunction(entry.construct, { locals: [], body: [{ op: "unreachable" }] });
  });
  // A fresh ordinary property bag with an accessor; the common Call receives an empty argv.
  tx.fillFunction(own, {
    locals: [{ name: "object", type: ext }],
    body: [
      ...prefix,
      { op: "ref.null.extern" },
      global(realmGlobal),
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: f.pack.types.state.typeIndex },
      { op: "struct.new", typeIdx: f.pack.types.ordinary.typeIndex },
      { op: "extern.convert_any" },
      { op: "local.set", index: 1 },
      get(1),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: f.objects.object.typeIndex },
      ...key,
      { op: "extern.convert_any" },
      { op: "ref.null", typeIdx: -18 },
      n(8),
      n(0),
      { op: "call", funcIdx: r.storage.insert.handle },
      get(1),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: f.objects.object.typeIndex },
      ...key,
      { op: "extern.convert_any" },
      { op: "call", funcIdx: r.lookup.findOwn.handle },
      { op: "ref.as_non_null" },
      get(0),
      { op: "any.convert_extern" },
      { op: "struct.set", typeIdx: f.objects.propEntry.typeIndex, fieldIdx: 4 },
      get(1),
    ],
  });
  tx.fillFunction(bag, {
    locals: [],
    body: [
      get(0),
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: c.closures.root.typeIndex },
      {
        op: "if",
        blockType: { kind: "val", type: ext },
        then: [
          get(0),
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: c.closures.root.typeIndex },
          { op: "struct.get", typeIdx: c.closures.root.typeIndex, fieldIdx: 2 },
        ],
        else: [get(0)],
      },
    ],
  });
  tx.fillFunction(inspect, {
    locals: [],
    body: [2, 3, 1, 4, 5].flatMap((fieldIdx): Instr[] => [
      get(0),
      { op: "call", funcIdx: bag.handle },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: f.objects.object.typeIndex },
      get(1),
      { op: "call", funcIdx: r.lookup.findOwn.handle },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: f.objects.propEntry.typeIndex, fieldIdx },
      ...(fieldIdx < 2 || fieldIdx > 3 ? [{ op: "extern.convert_any" } as Instr] : []),
    ]),
  });
  const catalog = realm.realm.description.catalog.intrinsics;
  const literalNames = [
    "then",
    "missingPromiseProperty",
    ...new Set(
      catalog.flatMap((entry) =>
        entry.properties.flatMap((p) => [
          ...(p.key.kind === "string" ? [p.key.value] : []),
          ...(p.kind === "data" && p.value.kind === "string" ? [p.value.value] : []),
        ]),
      ),
    ),
  ];
  const literals = Object.fromEntries(
    literalNames.map((name, index) => {
      const token = requireNativeStringLiteral(tx, f.strings, name);
      return ["literal" + index, token.kind === "global" ? token.global : token.function];
    }),
  );
  const binding = nativeInvocationObjectRealmBinding(tx, r.invocation);
  expect(requireCompletedNativeRealmPopulation(tx, r.population.pack)).toBe(r.population.pack);
  const exports = {
    ...literals,
    object,
    property,
    format: decimal.toString,
    getterMode,
    trace,
    argument,
    toNumber: coercion.toNumber,
    toLength: coercion.toLength,
    boxBigInt: r.population.bigints.box,
    boxSymbol: r.symbols.functions.box,
    foreignClone,
    isCallable: nativeInvocationCallableBinding(tx, r.invocation, true).isCallable,
    isUndefined: r.invocation.isUndefined,
    undefinedValue: r.invocation.undefinedValue,
    inspect,
    bag,
    getPrototypeOf: r.access.getPrototypeOf,
    populate: initialize,
    state: realm.globals.state,
    wholeRealmReady: realm.globals.wholeRealmReady,
    objectPrototype: realm.objectPrototype.singleton,
    promisePrototype: realm.ordinaryIntrinsics.find((entry) => entry.intrinsic.id === "%Promise.prototype%")!.singleton,
    same: r.population.sameValue.sameValue,
    ...Object.fromEntries(r.population.symbols.producers.map((row) => [row.name, row.function])),
    findOwn: r.lookup.findOwn,
    accessor: own,
    get: r.access.get,
    own: r.access.own,
    has: r.access.has,
    call: binding.call,
    match: r.calls.match,
    newVector: f.substrate.arguments.newVector,
    push: f.substrate.arguments.push,
    box: r.values.functions.boxNumber,
    unbox: r.values.functions.unboxNumber,
    key: literal.global,
    argc,
    exception: f.exception.tag,
    ...Object.fromEntries(realm.entries.map((e, i) => ["native" + i, e.singleton])),
    ...Object.fromEntries(r.source.factories.map((e) => [e.name, e.slot])),
  };
  for (const [name, token] of Object.entries(exports)) tx.defineExport("control:export:" + name, name, token);
  // Even a fully filled ledger of controls must not be confused with implemented standard algorithms.
  expect(() => requireCompletedNativeInvocation(tx, r.invocation)).toThrow(/full Object\/Function\/Promise algorithms/);
  await setImmediate();
  expect(() => requireCompletedNativeMixedObjectAccess(tx, r.access)).toThrow(
    /full Object\/Function\/Promise algorithms/,
  );
  tx.seal();
  const wasm = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  return {
    api: new WebAssembly.Instance(wasm).exports as Record<string, any>,
    count: realm.entries.length,
    catalog,
    literalNames,
    implemented,
  };
}
/** Exercise real descriptor population and Get; injected getters observe only Call transport. */
function checkIntrinsicAbsence(api: Record<string, any>, intrinsics: unknown[], key: unknown) {
  const receiver = { missingThen: true },
    ordinary = api.object(api.objectPrototype.value);
  for (const value of [...intrinsics, ordinary]) {
    expect(api.own(value, key)[0]).toBe(0);
    const result = api.get(value, key, receiver);
    expect(result[0]).toBe(0);
    expect(api.isUndefined(result[1])).toBe(1);
    expect(api.has(value, key)).toBe(0);
  }
  for (const state of [0, 1, -1]) {
    api.state.value = state;
    for (const value of intrinsics) expect(api.own(value, key)[0]).toBe(2);
    expect(api.get(ordinary, key, receiver)[0]).toBe(2);
  }
  api.state.value = 2;
  const parent = api.objectPrototype.value;
  // A real own entry wins even when absence cannot yet be certified.
  api.property(parent, key, api.undefinedValue(), 7);
  api.state.value = 1;
  expect(api.get(ordinary, key, receiver)[0]).toBe(1);
  api.state.value = 2;
  const present = api.get(ordinary, key, receiver);
  expect(present[0]).toBe(1);
  expect(api.isUndefined(present[1])).toBe(1);
  expect(api.has(ordinary, key)).toBe(1);
  api.property(parent, key, api.native3.value, 8);
  for (const value of [...intrinsics, ordinary]) {
    expect(api.get(value, key, receiver)).toEqual([1, receiver]);
    expect(api.argc.value).toBe(0);
  }
  const nearer = api.object(parent);
  api.property(nearer, key, api.box(17), 7);
  expect(api.unbox(api.get(nearer, key, receiver)[1])).toBe(17);
  // Tombstone is the storage representation after deletion; this control does not implement Delete.
  api.property(parent, key, null, 128);
  for (const value of [...intrinsics, ordinary]) {
    expect(api.has(value, key)).toBe(0);
    expect(api.get(value, key, receiver)[0]).toBe(0);
  }
  expect(api.get(api.makeEmpty(), key, receiver)[0]).toBe(2);
  expect(api.get(api.foreignClone(api.makeEmpty()), key, receiver)[0]).toBe(3);
}

for (const displaced of [false, true])
  it(`executes all full-catalog adapters and source Get through common Call (displaced=${displaced})`, async () => {
    const { api, count, catalog, literalNames, implemented } = await executable(displaced);
    api.populate();
    expect(count).toBe(57);
    expect(api.state.value).toBe(2);
    expect(api.wholeRealmReady.value).toBe(0);
    const identities = Array.from({ length: count }, (_, i) => api["native" + i].value);
    api.populate();
    expect(identities.every((value, i) => api.same(value, api["native" + i].value) === 1)).toBe(true);
    const literalValue = (name: string) => {
      const item = api["literal" + literalNames.indexOf(name)];
      return typeof item === "function" ? item() : item.value;
    };
    const intrinsic = (id: string) =>
      id === "%Object.prototype%"
        ? api.objectPrototype.value
        : id === "%Promise.prototype%"
          ? api.promisePrototype.value
          : api["native" + catalog.filter((entry) => entry.callable).findIndex((entry) => entry.id === id)].value;
    let descriptors = 0;
    for (const entry of catalog) {
      const object = intrinsic(entry.id);
      const parent = api.getPrototypeOf(object);
      expect(parent[0]).toBe(1);
      if (entry.prototype === null) expect(parent[1]).toBe(null);
      else expect(api.same(parent[1], intrinsic(entry.prototype))).toBe(1);
      for (const [ordinal, property] of entry.properties.entries()) {
        const key =
          property.key.kind === "string" ? literalValue(property.key.value) : api[property.key.value.slice(7)]();
        const [flags, seq, value, getter, setter] = api.inspect(object, key);
        expect(seq).toBe(ordinal);
        expect(flags).toBe(
          (property.configurable ? 4 : 0) | (property.kind === "accessor" ? 8 : property.writable ? 1 : 0),
        );
        if (property.kind === "accessor") {
          expect(api.same(getter, intrinsic(property.get))).toBe(1);
          if (property.set === null) expect(setter).toBe(null);
          else expect(api.same(setter, intrinsic(property.set))).toBe(1);
        } else if (property.value.kind === "number") expect(api.unbox(value)).toBe(property.value.value);
        else
          expect(
            api.same(
              value,
              property.value.kind === "intrinsic" ? intrinsic(property.value.id) : literalValue(property.value.value),
            ),
          ).toBe(1);
        ++descriptors;
      }
    }
    expect(catalog).toHaveLength(59);
    expect(descriptors).toBe(174);
    const promisePrototype = intrinsic("%Promise.prototype%");
    expect(api.isCallable(promisePrototype)).toBe(0);
    const inheritor = api.object(promisePrototype);
    const missing = literalValue("missingPromiseProperty");
    for (const state of [0, 1, -1]) {
      api.state.value = state;
      expect(api.own(promisePrototype, missing)[0]).toBe(2);
      expect(api.get(promisePrototype, missing, promisePrototype)[0]).toBe(2);
      expect(api.own(inheritor, missing)[0]).toBe(0);
      expect(api.get(inheritor, missing, inheritor)[0]).toBe(2);
    }
    api.state.value = 2;
    expect(api.own(promisePrototype, missing)[0]).toBe(0);
    expect(api.get(inheritor, missing, inheritor)[0]).toBe(0);
    const inheritedThen = api.get(inheritor, literalValue("then"), inheritor);
    expect(inheritedThen[0]).toBe(1);
    expect(api.same(inheritedThen[1], intrinsic("%Promise.prototype.then%"))).toBe(1);
    expect(api.isCallable(inheritedThen[1])).toBe(1);
    expect(api.same(api.get(inheritor, literalValue("constructor"), inheritor)[1], intrinsic("%Promise%"))).toBe(1);
    expect(api.same(api.get(inheritor, api.toStringTag(), inheritor)[1], literalValue("Promise"))).toBe(1);
    api.populate();
    expect(api.same(promisePrototype, intrinsic("%Promise.prototype%"))).toBe(1);
    checkIntrinsicAbsence(
      api,
      catalog.filter((entry) => entry.id !== "%Promise.prototype%").map((entry) => intrinsic(entry.id)),
      literalValue("then"),
    );
    expect(api.inspect(intrinsic("%Function.prototype%"), api.hasInstance())[0]).toBe(0);
    expect(api.inspect(intrinsic("%ThrowTypeError%"), literalValue("name"))[0]).toBe(0);
    const receiver = { identity: "receiver" };
    const args = api.newVector();
    api.push(args, receiver);
    api.push(args, null);
    for (let i = 0; i < count; ++i) {
      const native = api["native" + i].value;
      expect(api.match(native)).toBe(i + 1);
      expect(api.isCallable(native)).toBe(1);
      if (implemented.includes(catalog.filter((entry) => entry.callable)[i]!.id)) continue;
      if (i === 2) {
        try {
          api.call(native, receiver, args);
          throw Error("missing abrupt completion");
        } catch (error) {
          expect(error).toBeInstanceOf(WebAssembly.Exception);
          expect((error as WebAssembly.Exception).getArg(api.exception, 0)).toBe(receiver);
        }
      } else expect(api.call(native, receiver, args)).toBe(receiver);
      expect(api.argc.value).toBe(2);
    }
    const saved = api.native0.value;
    for (const invalid of [null, receiver]) {
      api.native0.value = invalid;
      expect(api.match(saved)).toBe(0);
      expect(api.isCallable(saved)).toBe(0);
      expect(() => api.call(saved, receiver, args)).toThrow(WebAssembly.Exception);
    }
    api.native0.value = saved;
    const object = api.accessor(api.native3.value);
    expect(api.get(object, api.key.value, receiver)).toEqual([1, receiver]);
    expect(api.argc.value).toBe(0);
    const closure = api.makeCaptured(100),
      empty = api.makeEmpty();
    for (const value of [NaN, -0, 0, -1, 0.5, 3.75, 4294967297.75, 9007199254740992, Infinity, -Infinity]) {
      expect(Object.is(api.toNumber(api.box(value)), value)).toBe(true);
      expect(
        Object.is(api.toLength(api.box(value)), value > 0 ? Math.min(Math.trunc(value), 9007199254740991) : 0),
      ).toBe(true);
    }
    expect(api.toLength(api.undefinedValue())).toBe(0);
    expect(api.toLength(null)).toBe(0);
    for (const value of [api.boxBigInt(1n), api.hasInstance()]) {
      expect(() => api.toNumber(value)).toThrow(WebAssembly.Exception);
      expect(() => api.toLength(value)).toThrow(WebAssembly.Exception);
    }
    expect(Number.isNaN(api.toNumber(literalValue("name")))).toBe(true);
    const numeric = api.object(null);
    api.property(numeric, literalValue("valueOf"), empty, 0);
    expect(api.toNumber(numeric)).toBe(7);
    expect(api.toLength(numeric)).toBe(7);
    const exotic = api.object(numeric);
    api.property(exotic, api.boxSymbol(3), empty, 0);
    expect(api.toNumber(exotic)).toBe(7);
    const throwing = api.object(null);
    api.property(throwing, api.boxSymbol(3), api.native2.value, 8);
    try {
      api.toLength(throwing);
      throw Error("missing coercion throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WebAssembly.Exception);
      expect((error as WebAssembly.Exception).getArg(api.exception, 0)).toBe(throwing);
    }
    expect(api.toLength(numeric)).toBe(7);
    // Unsupported source-property families stay explicit gaps, not missing properties/NaN.
    expect(() => api.toNumber(empty)).toThrow(WebAssembly.RuntimeError);
    const callMethod = intrinsic("%Function.prototype.call%");
    const argsOf = (...values: unknown[]) => {
      const vector = api.newVector();
      for (const value of values) api.push(vector, value);
      return vector;
    };
    const methodCall = (target: unknown, ...values: unknown[]) => api.call(callMethod, target, argsOf(...values));
    const applyMethod = intrinsic("%Function.prototype.apply%");
    const methodApply = (target: unknown, ...values: unknown[]) => api.call(applyMethod, target, argsOf(...values));
    for (const argArray of [null, api.undefinedValue()]) {
      expect(methodApply(api.native3.value, receiver, argArray)).toBe(receiver);
      expect(api.argc.value).toBe(0);
    }
    expect(api.isUndefined(methodApply(api.native3.value))).toBe(1);
    const parentList = api.object(null),
      list = api.object(parentList);
    api.property(list, literalValue("length"), api.box(3.75), 0);
    api.property(list, api.format(0), api.box(12), 0);
    api.property(parentList, api.format(1), receiver, 0);
    expect(methodApply(api.native3.value, receiver, list)).toBe(receiver);
    expect(api.argc.value).toBe(3);
    expect(api.unbox(api.argument(0))).toBe(12);
    expect(api.argument(1)).toBe(receiver);
    expect(api.isUndefined(api.argument(2))).toBe(1);
    expect(api.unbox(methodApply(closure, receiver, list))).toBe(112);
    for (const invalid of [api.box(1), literalValue("name"), api.hasInstance()])
      expect(() => methodApply(api.native3.value, receiver, invalid)).toThrow(WebAssembly.Exception);
    const observed = api.object(null);
    api.property(observed, literalValue("length"), api.native4.value, 8);
    api.property(observed, api.format(0), api.native5.value, 8);
    api.property(observed, api.format(1), api.native6.value, 8);
    api.getterMode.value = 1;
    api.trace.value = 0;
    expect(methodApply(api.native3.value, receiver, observed)).toBe(receiver);
    expect(api.trace.value).toBe(4563);
    expect(api.unbox(api.argument(0))).toBe(41);
    expect(api.unbox(api.argument(1))).toBe(42);
    api.trace.value = 0;
    expect(api.unbox(methodApply(closure, receiver, observed))).toBe(141);
    expect(api.trace.value).toBe(456);
    api.trace.value = 0;
    expect(() => methodApply(null, receiver, observed)).toThrow(WebAssembly.Exception);
    expect(api.trace.value).toBe(0);
    for (const length of [4294967297, Infinity]) {
      const early = api.object(null);
      api.property(early, literalValue("length"), api.box(length), 0);
      api.property(early, api.format(0), api.native2.value, 8);
      api.trace.value = 0;
      try {
        methodApply(api.native3.value, receiver, early);
        throw Error("missing early index throw");
      } catch (error) {
        expect(error).toBeInstanceOf(WebAssembly.Exception);
        expect((error as WebAssembly.Exception).getArg(api.exception, 0)).toBe(early);
      }
      expect(api.trace.value).toBe(2);
    }
    api.getterMode.value = 0;
    const convertedLength = api.object(null);
    api.property(convertedLength, literalValue("length"), numeric, 0);
    expect(methodApply(api.native3.value, receiver, convertedLength)).toBe(receiver);
    expect(api.argc.value).toBe(7);
    expect(() => methodApply(api.native3.value, receiver, empty)).toThrow(WebAssembly.RuntimeError);
    try {
      methodApply(api.native2.value, receiver, null);
      throw Error("missing target throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WebAssembly.Exception);
      expect((error as WebAssembly.Exception).getArg(api.exception, 0)).toBe(receiver);
    }
    expect(methodApply(api.native3.value, receiver, list)).toBe(receiver);

    expect(api.isUndefined(api.call(intrinsic("%Function.prototype%"), receiver, args))).toBe(1);
    expect(() => api.call(intrinsic("%ThrowTypeError%"), receiver, args)).toThrow(WebAssembly.Exception);
    expect(api.isCallable(closure)).toBe(1);
    expect(api.isCallable(empty)).toBe(1);
    for (const original of [closure, empty]) {
      const foreign = api.foreignClone(original);
      expect(api.isCallable(foreign)).toBe(0);
      expect(() => api.call(foreign, receiver, argsOf(api.box(12)))).toThrow(WebAssembly.Exception);
      expect(() => methodCall(foreign, receiver, api.box(12))).toThrow(WebAssembly.Exception);
    }
    for (const bad of [null, receiver, api.box(12), api.undefinedValue()]) {
      expect(api.isCallable(bad)).toBe(0);
      expect(() => methodCall(bad)).toThrow(WebAssembly.Exception);
    }
    expect(methodCall(api.native3.value, receiver, api.box(1), api.box(2))).toBe(receiver);
    expect(api.argc.value).toBe(2);
    expect(api.isUndefined(methodCall(api.native3.value))).toBe(1);
    expect(api.argc.value).toBe(0);
    expect(methodCall(api.native3.value, null)).toBe(null);
    expect(api.unbox(methodCall(closure, receiver, api.box(12)))).toBe(112);
    expect(api.unbox(methodCall(empty))).toBe(7);
    expect(methodCall(callMethod, api.native3.value, receiver, api.box(4))).toBe(receiver);
    expect(api.argc.value).toBe(1);
    try {
      methodCall(api.native2.value, receiver);
      throw Error("missing abrupt completion");
    } catch (error) {
      expect(error).toBeInstanceOf(WebAssembly.Exception);
      expect((error as WebAssembly.Exception).getArg(api.exception, 0)).toBe(receiver);
    }
    expect(methodCall(api.native3.value, receiver)).toBe(receiver);
    const one = api.newVector();
    api.push(one, api.box(12));
    expect(api.unbox(api.call(closure, receiver, one))).toBe(112);
    expect(api.unbox(api.call(empty, null, one))).toBe(7);
    const result = api.get(api.accessor(empty), api.key.value, receiver);
    expect(result[0]).toBe(1);
    expect(api.unbox(result[1])).toBe(7);
    expect(() => api.get(api.accessor(closure), api.key.value, receiver)).toThrow(WebAssembly.Exception);
    expect(api.match(closure)).toBe(0);
    expect(() => api.call(receiver, receiver, one)).toThrow(WebAssembly.Exception);
    expect(api.unbox(api.call(closure, null, one))).toBe(112);
    for (const state of [1, -1]) {
      api.state.value = state;
      expect(() => api.populate()).toThrow(WebAssembly.Exception);
      expect(api.state.value).toBe(state);
      expect(identities.every((value, i) => api.same(value, api["native" + i].value) === 1)).toBe(true);
    }
  }, 900000);
