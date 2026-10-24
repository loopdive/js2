// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeEach, afterEach, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  fullRealmFixture,
  joinFullRealm,
  fillFullRealm,
  fillFullRealmSourceUnits,
} from "./helpers/native-full-realm-call.js";
import {
  nativePromiseObjectBinding,
  reserveNativePromiseObjects,
  fillNativePromiseObjects,
} from "../src/backend/wasmgc/resources/native-promise-objects.js";
import { checkRealmFrameRejections } from "./helpers/native-realm-frame-controls.js";
import { reserveRealmAsyncFrame } from "./helpers/native-realm-async-frame.js";
import { bindNativeMixedObjectPromises } from "../src/backend/wasmgc/resources/native-mixed-object-access.js";
import { requireNativeStringLiteral } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { buildRealmOrdinaryObjectAllocation } from "../src/runtime/wasmgc/values/realm-object-layouts.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
const source = "\nexport async function run(seed: number): Promise<number> { return await seed; }";
const ext = { kind: "externref" } as const,
  i32 = { kind: "i32" } as const;
const get = (index: number): Instr => ({ op: "local.get", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
async function drain() {
  await setImmediate();
  await setImmediate();
}
beforeEach(drain);
afterEach(drain);

it("authenticates the shared Promise/realm producer before allocating slots", () => {
  const r = fullRealmFixture(false, source),
    { tx } = r;
  const pack = r.promiseObjects!;
  const before = r.f.module.functions.length;
  expect(() => nativePromiseObjectBinding(tx, { ...pack })).toThrow(/foreign or copied/);
  expect(() => reserveNativePromiseObjects(tx, "copied", { ...r.population.pack }, r.promise!.association)).toThrow(
    /foreign or copied/,
  );
  expect(() => reserveNativePromiseObjects(tx, "copied", r.population.pack, { ...r.promise!.association })).toThrow(
    /foreign|copied/,
  );
  expect(() => reserveNativePromiseObjects(tx, "duplicate", r.population.pack, r.promise!.association)).toThrow(
    /already has/,
  );
  expect(r.f.module.functions.length).toBe(before);
  expect(nativePromiseObjectBinding(tx, pack).promise).toBe(r.promise!.resources.types.promise);
  expect(() => bindNativeMixedObjectPromises(tx, r.access, { ...pack })).toThrow(/foreign or copied/);
  joinFullRealm(r);
  expect(() => bindNativeMixedObjectPromises(tx, r.access, pack)).toThrow(/duplicate/);
  expect(() => fillNativePromiseObjects(tx, pack)).toThrow(/invalid phase/);
}, 240000);

async function runtime(displaced: boolean) {
  const r = fullRealmFixture(displaced, source),
    { tx, f } = r;
  joinFullRealm(r);
  const asyncFrame = reserveRealmAsyncFrame(r);
  const pack = r.promiseObjects!,
    promiseType = pack.promise.types.promise.typeIndex;
  const fn = (name: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunction("control:promise:" + name, name, { params, results });
  const create = fn("create", [i32], [ext]);
  const alternate = fn("alternate", [i32], [{ kind: "ref", typeIdx: promiseType }]);
  const bag = fn("bag", [ext], [ext]);
  const setBag = fn("setBag", [ext, ext], []);
  const state = fn("state", [ext], [i32]);
  const value = fn("value", [ext], [ext]);
  const handled = fn("handled", [ext], [i32]);
  const property = fn("property", [ext, ext, ext], []);
  const getter = fn("getter", [ext, ext, ext], []);
  const ordinary = fn("ordinary", [ext, i32], [ext]);
  const nonExtensible = fn("nonExtensible", [ext], []);
  const cast = (index: number, typeIdx: number): Instr[] => [
    get(index),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx },
  ];
  const read = (fieldIdx: number): Instr[] => [
    ...cast(0, promiseType),
    { op: "struct.get", typeIdx: promiseType, fieldIdx },
  ];
  const own: Instr[] = [
    ...read(3),
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: f.objects.object.typeIndex },
  ];
  await fillFullRealm(r);
  fillFullRealmSourceUnits(r);
  tx.fillFunction(alternate, {
    locals: [],
    body: [
      n(0),
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      get(0),
      { op: "struct.new", typeIdx: promiseType },
    ],
  });
  if (!displaced) checkRealmFrameRejections(tx, asyncFrame, alternate);
  asyncFrame.fill();
  expect(nativePromiseObjectBinding(tx, pack, true).create).toBe(pack.create);
  tx.fillFunction(create, {
    locals: [],
    body: [get(0), { op: "call", funcIdx: pack.create.handle }, { op: "extern.convert_any" }],
  });
  tx.fillFunction(bag, { locals: [], body: read(3) });
  tx.fillFunction(setBag, {
    locals: [],
    body: [...cast(0, promiseType), get(1), { op: "struct.set", typeIdx: promiseType, fieldIdx: 3 }],
  });
  tx.fillFunction(state, { locals: [], body: read(0) });
  tx.fillFunction(value, { locals: [], body: read(1) });
  tx.fillFunction(handled, { locals: [], body: read(4) });
  tx.fillFunction(property, {
    locals: [],
    body: [
      ...own,
      get(1),
      get(2),
      { op: "any.convert_extern" },
      n(7),
      n(0),
      { op: "call", funcIdx: r.storage.insert.handle },
    ],
  });
  tx.fillFunction(getter, {
    locals: [],
    body: [
      ...read(3),
      get(1),
      get(2),
      { op: "global.get", index: tx.physicalIndex(r.values.globals.undefined) },
      { op: "extern.convert_any" },
      { op: "f64.const", value: 256 + 512 + 16 + 32 + 2 + 4 },
      { op: "call", funcIdx: r.population.descriptors.defineAccessor.handle },
    ],
  });
  tx.fillFunction(nonExtensible, {
    locals: [],
    body: [...own, n(1), { op: "struct.set", typeIdx: f.objects.object.typeIndex, fieldIdx: 4 }],
  });
  tx.fillFunction(ordinary, {
    locals: [],
    body: [
      ...buildRealmOrdinaryObjectAllocation(
        { objectTypeIdx: f.objects.object.typeIndex, propMapTypeIdx: f.objects.propMap.typeIndex, initialCapacity: 8 },
        {
          allocationTypeIdx: f.pack.types.ordinary.typeIndex,
          stateTypeIdx: f.pack.types.state.typeIndex,
          prototype: [get(0)],
          realm: [
            get(1),
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "ref", typeIdx: f.pack.types.identity.typeIndex } },
              then: [{ op: "struct.new", typeIdx: f.pack.types.identity.typeIndex }],
              else: [
                { op: "global.get", index: tx.physicalIndex(r.realm.declarations.globals.realm) },
                { op: "ref.as_non_null" },
              ],
            },
          ],
        },
      ),
      { op: "extern.convert_any" },
    ],
  });
  // Object production is exercised here. Settlement and builtin algorithms are
  // explicit unreachable controls; none can certify complete Promise execution.
  for (const entry of r.realm.declarations.entries) {
    tx.fillFunction(entry.algorithm, { locals: [], body: [{ op: "unreachable" }] });
    if (entry.construct) tx.fillFunction(entry.construct, { locals: [], body: [{ op: "unreachable" }] });
  }
  for (const token of Object.values(pack.promise.functions))
    if (!asyncFrame.implemented.has(token)) tx.fillFunction(token, { locals: [], body: [{ op: "unreachable" }] });
  for (const token of Object.values(pack.promise.globals)) {
    const type = token.object.type;
    tx.fillGlobal(
      token,
      type.kind === "i32" ? [n(0)] : [{ op: "ref.null", typeIdx: (type as { typeIdx: number }).typeIdx }],
    );
  }
  const realm = r.realm.declarations;
  const exports = {
    create,
    bag,
    setBag,
    state,
    value,
    handled,
    property,
    getter,
    ordinary,
    nonExtensible,
    get: r.access.get,
    own: r.access.own,
    has: r.access.has,
    getPrototypeOf: r.access.getPrototypeOf,
    setPrototypeOf: r.access.setPrototypeOf,
    realmState: realm.globals.state,
    prototype: realm.ordinaryIntrinsics.find((e) => e.intrinsic.id === "%Promise.prototype%")!.singleton,
    then: realm.entries.find((e) => e.request.intrinsic.id === "%Promise.prototype.then%")!.singleton,
    constructor: realm.entries.find((e) => e.request.intrinsic.id === "%Promise%")!.singleton,
    objectPrototype: realm.objectPrototype.singleton,
    undefined: r.values.globals.undefined,
    unbox: r.values.functions.unboxNumber,
    ...Object.fromEntries(r.source.factories.map((row) => [row.name, row.slot])),
  };
  for (const [name, token] of Object.entries(exports)) tx.defineExport("control:promise:export:" + name, name, token);
  for (const text of ["then", "constructor", "missingPromiseProperty"]) {
    const token = requireNativeStringLiteral(tx, f.strings, text);
    if (token.kind !== "global") throw Error("expected literal global");
    tx.defineExport("control:promise:key:" + text, "key:" + text, token.global);
  }
  tx.seal();
  const wasm = new WebAssembly.Module(emitBinary(f.module) as BufferSource);
  expect(WebAssembly.Module.imports(wasm)).toEqual([]);
  return new WebAssembly.Instance(wasm).exports as Record<string, any>;
}
function expectAccess(actual: [number, unknown], value: unknown, detail: string) {
  expect(actual[0], detail + " status").toBe(1);
  expect(Object.is(actual[1], value), detail + " identity").toBe(true);
}
for (const displaced of [false, true])
  it(`creates real Promise property storage and inherits through common Get, displaced=${displaced}`, async () => {
    const api = await runtime(displaced);
    expect(api.realmState.value).toBe(0);
    const result = api.run(17.25);
    expect(api.state(result)).toBe(0);
    expectAccess(api.getPrototypeOf(result), api.prototype.value, "result prototype");
    expectAccess(api.get(result, api["key:then"].value, result), api.then.value, "result then");
    const adapter = api.awaitAdapter.value;
    expect(adapter).not.toBeNull();
    expect(adapter !== result, "separate await adapter").toBe(true);
    expect(api.handled(adapter)).toBe(1);
    expect(api.bag(adapter) !== api.bag(result), "separate await adapter storage").toBe(true);
    expectAccess(api.getPrototypeOf(adapter), api.prototype.value, "await adapter prototype");
    api.drain();
    expect(api.state(result)).toBe(1);
    expect(api.unbox(api.value(result))).toBe(17.25);
    const p = api.create(0),
      q = api.create(1),
      receiver = { actualReceiver: true };
    expect(api.realmState.value).toBe(2);
    expect(api.state(p)).toBe(0);
    expect(api.handled(p)).toBe(0);
    expect(api.handled(q)).toBe(1);
    expect(api.bag(p) !== api.bag(q), "fresh allocation storage").toBe(true);
    expectAccess(api.getPrototypeOf(p), api.prototype.value, "created Promise prototype");
    expectAccess(api.get(p, api["key:then"].value, receiver), api.then.value, "inherited then");
    expectAccess(
      api.get(p, api["key:constructor"].value, receiver),
      (api["constructor"] as WebAssembly.Global).value,
      "inherited constructor",
    );
    const key = api["key:missingPromiseProperty"].value;
    expect(api.get(p, key, receiver)[0]).toBe(0);
    api.property(p, key, api.undefined.value);
    expectAccess(api.get(p, key, receiver), api.undefined.value, "own undefined");
    api.getter(q, key, api.makeEmpty());
    expect(api.unbox(api.get(q, key, receiver)[1])).toBe(7);
    const parent = api.ordinary(api.prototype.value, 0);
    expect(api.setPrototypeOf(p, parent)).toBe(1);
    expectAccess(api.getPrototypeOf(p), parent, "changed prototype");
    expect(api.setPrototypeOf(parent, p)).toBe(0);
    api.nonExtensible(p);
    expect(api.setPrototypeOf(p, api.prototype.value)).toBe(0);
    const originalBag = api.bag(q);
    api.setBag(q, null);
    expect(api.getPrototypeOf(q)[0]).toBe(2);
    api.setBag(q, receiver);
    expect(api.getPrototypeOf(q)[0]).toBe(3);
    api.setBag(q, api.ordinary(api.prototype.value, 1));
    expect(api.getPrototypeOf(q)[0]).toBe(3);
    api.setBag(q, originalBag);
    api.realmState.value = 1;
    expect(api.getPrototypeOf(q)[0]).toBe(2);
    expect(() => api.create(0)).toThrow();
    api.realmState.value = 2;
    expectAccess(api.getPrototypeOf(q), api.prototype.value, "restored prototype");
  }, 900000);
