// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../src/backend/wasmgc/resources/native-object-layouts.js";
import { buildRealmPopulationInitializer } from "../src/runtime/wasmgc/values/realm-population-bodies.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr } from "../src/wasm/model/instructions.js";

/** Fault-injection recipe test, deliberately independent of full-realm admission and builtin semantics. */
function faultKernel(reenter: boolean) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ext = { kind: "externref" } as const;
  const objectRequirements = { key: "fault:objects", extensible: true as const };
  const objects = reserveNativeObjectLayouts(tx, objectRequirements, declareNativeObjectLayouts(objectRequirements));
  if (objects.object.object.kind !== "struct") throw Error("missing ordinary storage prefix");
  const objectType = tx.reserveType("fault:prototype", {
    ...objects.object.object,
    name: "FaultPrototype",
    superTypeIdx: objects.object.typeIndex,
    final: true,
  });
  const identity = tx.reserveType("fault:identity", { kind: "struct", name: "FaultRealm", fields: [] });
  const realm = tx.reserveGlobal("fault:realm", "realm", { kind: "ref_null", typeIdx: identity.typeIndex }, true);
  const object = tx.reserveGlobal("fault:object", "object", { kind: "ref_null", typeIdx: objectType.typeIndex }, true);
  const state = tx.reserveGlobal("fault:state", "state", { kind: "i32" }, true);
  const fault = tx.reserveGlobal("fault:original", "original", ext, true);
  const failed = tx.reserveGlobal("fault:failed", "failed", ext, true);
  const tag = tx.reserveTag("fault:exception", { params: [ext], results: [] }, { kind: "defined", name: "exception" });
  const initialize = tx.reserveFunction("fault:initialize", "initialize", { params: [], results: [] });
  const symbol = tx.reserveFunction("fault:symbol", "symbolFault", { params: [], results: [ext] });
  const create = tx.reserveFunction("fault:create", "unusedCreate", { params: [], results: [ext] });
  const box = tx.reserveFunction("fault:box", "unusedBox", { params: [{ kind: "f64" }], results: [ext] });
  const data = tx.reserveFunction("fault:data", "unusedData", {
    params: [ext, ext, ext, { kind: "f64" }],
    results: [ext],
  });
  const accessor = tx.reserveFunction("fault:accessor", "unusedAccessor", {
    params: [ext, ext, ext, ext, { kind: "f64" }],
    results: [ext],
  });
  tx.freezeReservations();
  tx.fillGlobal(realm, [{ op: "ref.null", typeIdx: identity.typeIndex }]);
  tx.fillGlobal(object, [{ op: "ref.null", typeIdx: objectType.typeIndex }]);
  tx.fillGlobal(state, [{ op: "i32.const", value: 0 }]);
  for (const token of [fault, failed]) tx.fillGlobal(token, [{ op: "ref.null.extern" }]);
  // Deliberate fault before any value or descriptor helper is reached. These are never runtime providers.
  for (const token of [create, box, data, accessor])
    tx.fillFunction(token, { locals: [], body: [{ op: "unreachable" }] });
  const throwValue = (index: number): Instr[] => [
    { op: "global.get", index },
    { op: "throw", tagIdx: tx.physicalIndex(tag) },
  ];
  tx.fillFunction(symbol, {
    locals: [],
    body: reenter
      ? [{ op: "call", funcIdx: initialize.handle }, { op: "unreachable" }]
      : throwValue(tx.physicalIndex(fault)),
  });
  tx.fillFunction(
    initialize,
    buildRealmPopulationInitializer({
      entries: [],
      objectPrototype: tx.physicalIndex(object),
      objectPrototypeType: objectType.typeIndex,
      objectIntrinsic: {
        id: "%Object.prototype%",
        aliases: [],
        prototype: null,
        extensible: true,
        immutablePrototype: true,
        constructible: false,
        normativeOptional: false,
        legacy: false,
        properties: [
          {
            key: { kind: "symbol", value: "Symbol.hasInstance" },
            kind: "data",
            writable: false,
            enumerable: false,
            configurable: false,
            value: { kind: "number", value: 0 },
          },
        ],
      },
      objectType: objects.object.typeIndex,
      propMapType: objects.propMap.typeIndex,
      realm: tx.physicalIndex(realm),
      realmType: identity.typeIndex,
      state: tx.physicalIndex(state),
      createNull: create.handle,
      boxNumber: box.handle,
      defineData: data.handle,
      defineAccessor: accessor.handle,
      hasInstance: symbol.handle,
      failure: throwValue(tx.physicalIndex(failed)),
      literal() {
        throw Error("fault control does not select literals");
      },
    }),
  );
  for (const [name, token] of Object.entries({ initialize, object, state, fault, failed, tag }))
    tx.defineExport("fault:export:" + name, name, token);
  tx.seal();
  const binary = new WebAssembly.Module(emitBinary(module) as BufferSource);
  expect(WebAssembly.Module.imports(binary)).toEqual([]);
  return new WebAssembly.Instance(binary).exports as Record<string, any>;
}
for (const reenter of [false, true])
  it(`retains abrupt initialization and original thrown identity (reenter=${reenter})`, () => {
    const api = faultKernel(reenter),
      original = { original: true },
      failed = { failed: true };
    api.fault.value = original;
    api.failed.value = failed;
    expect(api.state.value).toBe(0);
    const invoke = (expected: object) => {
      try {
        api.initialize();
        throw Error("missing initialization throw");
      } catch (error) {
        expect(error).toBeInstanceOf(WebAssembly.Exception);
        expect((error as WebAssembly.Exception).getArg(api.tag, 0)).toBe(expected);
      }
    };
    invoke(reenter ? failed : original);
    expect(api.state.value).toBe(-1);
    const allocated = api.object.value;
    expect(allocated).not.toBe(null);
    invoke(failed);
    expect(api.state.value).toBe(-1);
    expect(api.object.value).toBe(allocated);
  });
