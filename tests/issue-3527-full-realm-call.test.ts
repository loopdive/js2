// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { mixedOwnerFixture, reserveMixedOwner, fillMixedDependencies } from "./helpers/native-mixed-object-access.js";
import { publicRealmSourceSlots } from "./helpers/native-object-realm.js";
import {
  reserveNativeBooleanResources,
  fillNativeBooleanResources,
} from "../src/backend/wasmgc/resources/native-booleans.js";
import {
  reserveNativeObjectRealmCalls,
  fillNativeObjectRealmCalls,
  nativeObjectRealmInvocationBinding,
} from "../src/backend/wasmgc/resources/native-object-realm-calls.js";
import {
  reserveNativeInvocationResources,
  bindNativeInvocationObjectRealm,
  nativeInvocationObjectRealmBinding,
  fillNativeInvocationResources,
  requireCompletedNativeInvocation,
} from "../src/backend/wasmgc/resources/native-invocation.js";
import {
  bindNativeMixedObjectInvocation,
  fillNativeMixedObjectAccessStructure,
  fillNativeMixedObjectGet,
  requireCompletedNativeMixedObjectAccess,
} from "../src/backend/wasmgc/resources/native-mixed-object-access.js";
import { fillNativeObjectRealmDeclarations } from "../src/backend/wasmgc/resources/native-object-realm.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import {
  bindNativeSourceClosureUnits,
  nativeSourceClosureCallableBindings,
  nativeRealmSourceClosureCallableBindings,
  nativeSourceClosureResolver,
  fillPreparedPrimaryUnit,
} from "../src/ir/program-native-invocation.js";
import { requireNativeStringLiteral } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";

import { setImmediate } from "node:timers/promises";
afterEach(async () => {
  await setImmediate();
});

function fixture(displaced = false) {
  const r = mixedOwnerFixture(
      displaced,
      `export function makeCaptured(seed: number): (value: number) => number {
    return function captured(value: number): number { return seed + value; };
  }
  export function makeEmpty(): () => number { return function empty(): number { return 7; }; }`,
    ),
    { tx, f, c } = r;
  const source = publicRealmSourceSlots(f, c);
  const booleans = reserveNativeBooleanResources(tx, "test:booleans", r.values, r.valuePlan, r.valueDependencies);
  const dependencies = {
    realm: r.realm.declarations,
    realmDependencies: r.realm.dependencies,
    values: r.values,
    valuePlan: r.valuePlan,
    valueDependencies: r.valueDependencies,
    booleans,
  };
  const calls = reserveNativeObjectRealmCalls(tx, "test:realm-calls", dependencies);
  const requirements = planNativeInvocationRequirements(c.source!.requirements, { utf8Storage: displaced })!;
  const invocation = reserveNativeInvocationResources(tx, requirements, {
    source: c.source!.types,
    values: r.values,
    valuePlan: r.valuePlan,
    valueDependencies: r.valueDependencies,
    strings: f.strings,
    vectors: f.vectors,
    vectorPlan: f.vectorPlan,
    substrate: f.substrate,
  });
  const access = reserveMixedOwner(r);
  return { ...r, source, booleans, dependencies, calls, invocation, access };
}
function join(r: ReturnType<typeof fixture>) {
  bindNativeInvocationObjectRealm(r.tx, r.invocation, r.calls);
  bindNativeMixedObjectInvocation(r.tx, r.access, r.invocation);
}
async function fill(r: ReturnType<typeof fixture>) {
  const { tx, f, c } = r;
  tx.freezeReservations();
  bindNativeSourceClosureUnits(tx, c.source!, r.source.slots);
  fillMixedDependencies(r);
  await setImmediate();
  fillNativeBooleanResources(tx, r.booleans);
  fillNativeObjectRealmDeclarations(tx, r.realm.declarations);
  fillNativeObjectRealmCalls(tx, r.calls);
  await setImmediate();
  const selected = nativeSourceClosureCallableBindings(tx, c.source!, r.invocation.requirements);
  expect(() => fillNativeInvocationResources(tx, r.invocation, selected, f.exception.tag)).toThrow(
    /requires all source callables/,
  );
  const all = nativeRealmSourceClosureCallableBindings(tx, c.source!, f.realm);
  fillNativeInvocationResources(tx, r.invocation, selected, f.exception.tag, all);
  await setImmediate();
  fillNativeMixedObjectAccessStructure(tx, r.access);
  await setImmediate();
  fillNativeMixedObjectGet(tx, r.access);
}

describe("full public realm Call joins", { timeout: 120000 }, () => {
  it("rejects copied, foreign and accessor dependencies before reservation", () => {
    const r = fixture(),
      before = r.f.module.functions.length;
    expect(() => nativeObjectRealmInvocationBinding(r.tx, { ...r.calls })).toThrow(/foreign or copied/);
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
    expect(() => bindNativeInvocationObjectRealm(r.tx, r.invocation, other.calls)).toThrow(/foreign or copied/);
    expect(() => bindNativeMixedObjectInvocation(r.tx, r.access, r.invocation)).toThrow(/missing full public/);
    join(r);
    expect(nativeInvocationObjectRealmBinding(r.tx, r.invocation).realm).toBe(r.realm.declarations);
    expect(() => bindNativeInvocationObjectRealm(r.tx, r.invocation, r.calls)).toThrow(/duplicate/);
    expect(() => bindNativeMixedObjectInvocation(r.tx, r.access, r.invocation)).toThrow(/duplicate/);
  });
  it("detects dependency replacement and never grants complete realm authority from filled dispatch", async () => {
    const r = fixture();
    join(r);
    await fill(r);
    expect(() => nativeObjectRealmInvocationBinding(r.tx, r.calls, true)).toThrow(/full Object\/Function algorithms/);
    expect(() => fillNativeObjectRealmCalls(r.tx, r.calls)).toThrow(/duplicate/);
    expect(() => fillNativeMixedObjectGet(r.tx, r.access)).toThrow(/duplicate/);
    r.dependencies.values = { ...r.values };
    expect(() => nativeObjectRealmInvocationBinding(r.tx, r.calls)).toThrow(/changed dependency/);
  });
});

const ext = { kind: "externref" } as const;
const get = (index: number): Instr => ({ op: "local.get", index });
const global = (index: number): Instr => ({ op: "global.get", index });
const n = (value: number): Instr => ({ op: "i32.const", value });

/** Component control algorithms observe Call's receiver/argv. They are deliberately NOT builtin implementations. */
async function executable(displaced: boolean) {
  const r = fixture(displaced),
    { tx, f, c } = r,
    realm = r.realm.declarations;
  join(r);
  const initialize = tx.reserveFunction("control:populate", "populateControlCarriers", { params: [], results: [] });
  const own = tx.reserveFunction("control:accessor", "accessor", { params: [ext], results: [ext] });
  const argc = tx.reserveGlobal("control:argc", "argc", { kind: "i32" }, true);
  await fill(r);
  const resolver: IrLowerResolver = {
    ...nativeSourceClosureResolver(tx, c.source!),
    resolveFunc(ref) {
      const slot = ref.binding.kind === "unit" && r.source.slots.get(ref.binding.unitId);
      if (slot) return slot.handle;
      throw Error("unexpected callable");
    },
    resolveGlobal() {
      throw Error("unexpected global");
    },
    resolveType() {
      throw Error("unexpected type");
    },
    internFuncType(sig) {
      return tx.internFunctionType(sig.params, sig.results);
    },
  };
  for (const [id, slot] of r.source.slots)
    fillPreparedPrimaryUnit(
      tx,
      f.projection.prepared.functions.find((row) => row.unitId === id)!,
      slot,
      r.source.signatures.get(id)!,
      resolver,
      "wasmgc",
      c.source,
    );
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
  const op = tx.physicalIndex(realm.objectPrototype.singleton);
  tx.fillGlobal(argc, [n(-1)]);
  // Each native control reports the actual argument-vector length and returns its original receiver.
  // One control instead throws that exact receiver; unimplemented standard semantics gain no authority.
  realm.entries.forEach((entry, index) => {
    tx.fillFunction(entry.algorithm, {
      locals: [],
      body: [
        get(1),
        { op: "struct.get", typeIdx: f.substrate.arguments.carrier.typeIndex, fieldIdx: 0 },
        { op: "global.set", index: tx.physicalIndex(argc) },
        get(0),
        ...(index === 2 ? [{ op: "throw", tagIdx: tx.physicalIndex(f.exception.tag) } as Instr] : []),
      ],
    });
    if (entry.construct) tx.fillFunction(entry.construct, { locals: [], body: [{ op: "unreachable" }] });
  });
  tx.fillFunction(realm.initialize, { locals: [], body: [] }); // test population is explicit, never attested as a Realm initializer
  tx.fillFunction(initialize, {
    locals: [],
    body: [
      { op: "struct.new", typeIdx: f.pack.types.identity.typeIndex },
      { op: "global.set", index: realmGlobal },
      ...prefix,
      { op: "struct.new", typeIdx: f.pack.types.objectPrototype.typeIndex },
      { op: "global.set", index: op },
      ...realm.entries.flatMap((entry): Instr[] => [
        { op: "ref.func", funcIdx: entry.lifted.handle },
        n(entry.metadata.signature.info.paramTypes.length),
        { op: "call", funcIdx: r.storage.createNull.handle },
        n(0),
        n(entry.metadata.metadata.id),
        global(op),
        { op: "extern.convert_any" },
        global(realmGlobal),
        { op: "ref.as_non_null" },
        ...key,
        { op: "struct.new", typeIdx: entry.type.typeIndex },
        ...(entry.singleton.object.type.kind === "externref" ? [{ op: "extern.convert_any" } as Instr] : []),
        { op: "global.set", index: tx.physicalIndex(entry.singleton) },
      ]),
    ],
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
  const binding = nativeInvocationObjectRealmBinding(tx, r.invocation);
  const exports = {
    populate: initialize,
    accessor: own,
    get: r.access.get,
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
  expect(() => requireCompletedNativeInvocation(tx, r.invocation)).toThrow(/full Object\/Function algorithms/);
  await setImmediate();
  expect(() => requireCompletedNativeMixedObjectAccess(tx, r.access)).toThrow(/full Object\/Function algorithms/);
  tx.seal();
  const wasm = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  return { api: new WebAssembly.Instance(wasm).exports as Record<string, any>, count: realm.entries.length };
}
for (const displaced of [false, true])
  it(`executes all full-catalog adapters and source Get through common Call (displaced=${displaced})`, async () => {
    const { api, count } = await executable(displaced);
    api.populate();
    expect(count).toBe(44);
    const receiver = { identity: "receiver" };
    const args = api.newVector();
    api.push(args, receiver);
    api.push(args, null);
    for (let i = 0; i < count; ++i) {
      const native = api["native" + i].value;
      expect(api.match(native)).toBe(i + 1);
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
      expect(() => api.call(saved, receiver, args)).toThrow(WebAssembly.Exception);
    }
    api.native0.value = saved;
    const object = api.accessor(api.native0.value);
    expect(api.get(object, api.key.value, receiver)).toEqual([1, receiver]);
    expect(api.argc.value).toBe(0);
    const closure = api.makeCaptured(100),
      empty = api.makeEmpty();
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
  }, 120000);
