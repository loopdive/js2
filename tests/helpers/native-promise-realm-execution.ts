// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect } from "vitest";
import { fullRealmFixture, joinFullRealm, fillFullRealm, fillFullRealmSourceUnits } from "./native-full-realm-call.js";
import { nativePromiseObjectBinding } from "../../src/backend/wasmgc/resources/native-promise-objects.js";
import { checkRealmFrameRejections } from "./native-realm-frame-controls.js";
import { reserveRealmAsyncFrame } from "./native-realm-async-frame.js";
import { requireNativeStringLiteral } from "../../src/backend/wasmgc/resources/native-string-literals.js";
import { buildRealmOrdinaryObjectAllocation } from "../../src/runtime/wasmgc/values/realm-object-layouts.js";
import { emitBinary } from "../../src/emit/binary.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
export const promiseRealmSource = "\nexport async function run(seed: number): Promise<number> { return await seed; }";
const ext = { kind: "externref" } as const,
  i32 = { kind: "i32" } as const;
const get = (index: number): Instr => ({ op: "local.get", index });
const n = (value: number): Instr => ({ op: "i32.const", value });
import { reserveRealmCommonPromiseRuntime } from "./native-realm-common-promise-runtime.js";
export async function promiseRealmRuntime(displaced: boolean, common = false) {
  const r = fullRealmFixture(
      displaced,
      promiseRealmSource +
        (common
          ? `
export function makeThen(seed: number): (resolve: (value: number) => void) => void {
  return function then(resolve: (value: number) => void): void { resolve(seed); };
}
`
          : ""),
      common ? [{ name: "makeThen", signature: { params: [{ kind: "f64" }], results: [ext] } }] : [],
    ),
    { tx, f } = r;
  joinFullRealm(r);
  const core = common ? reserveRealmCommonPromiseRuntime(r) : undefined;
  const asyncFrame = reserveRealmAsyncFrame(r, core?.runtime);
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
  if (!displaced && !common) checkRealmFrameRejections(tx, asyncFrame, alternate);
  core?.fill();
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
  for (const token of common ? [] : Object.values(pack.promise.globals)) {
    const type = token.object.type;
    tx.fillGlobal(
      token,
      type.kind === "i32" ? [n(0)] : [{ op: "ref.null", typeIdx: (type as { typeIdx: number }).typeIdx }],
    );
  }
  const realm = r.realm.declarations;
  const exports = {
    create,
    ...(common ? { resolve: pack.promise.functions.resolveValue } : {}),
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
