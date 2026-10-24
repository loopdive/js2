// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createEmptyModule, type WasmModule } from "../../src/ir/types.js";
import { emitBinary } from "../../src/emit/binary.js";
import { PhysicalModuleReservations } from "../../src/wasm/physical/module-reservations.js";
import type { NativePromiseReservations } from "../../src/backend/wasmgc/resources/native-promises.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import {
  buildPromiseSettleClosureBody,
  buildPromiseSettleClosureValue,
} from "../../src/runtime/wasmgc/promise/resolution-bodies.js";

/** Execute the genuine reserved type table, without filling the incomplete Promise pack with stubs. */
export async function nativePromiseCaptureKernel(
  reserved: WasmModule,
  pack: NativePromiseReservations,
  rootType: number,
  metadataType: number,
) {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  reserved.types.forEach((type, index) => tx.reserveType("reserved-type:" + index, type));
  const ext = { kind: "externref" } as const,
    i32 = { kind: "i32" } as const;
  const ref = (typeIdx: number): ValType => ({ kind: "ref", typeIdx });
  const get = (index: number): Instr => ({ op: "local.get", index });
  const num = (value: number): Instr => ({ op: "i32.const", value });
  const fn = (name: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunction(name, name, { params, results });
  const promise = pack.types.promise.typeIndex,
    guard = pack.types.resolvingPair.typeIndex;
  const cap = {
    capTypeIdx: pack.types.settleCapture.typeIndex,
    capMetaTypeIdx: metadataType,
    capPromiseFieldIdx: 5,
    guardTypeIdx: guard,
  };
  const resolve = fn("resolve", [ref(rootType), ext], []);
  const reject = fn("reject", [ref(rootType), ext], []);
  // Callback spies intentionally leave the Promise pending: its state cannot mask a missing pair guard.
  const resolved = tx.reserveGlobal("resolved", "resolved", i32, true);
  const rejected = tx.reserveGlobal("rejected", "rejected", i32, true);
  const value = tx.reserveGlobal("value", "value", ext, true);
  const onResolve = fn("onResolve", [ref(promise), ext], [ext]);
  const onReject = fn("onReject", [ref(promise), ext], [ext]);
  const pair = fn("pair", [], [ext, ext]);
  const invokeResolve = fn("invokeResolve", [ext, ext], []);
  const invokeReject = fn("invokeReject", [ext, ext], []);
  const counts = fn("counts", [], [i32, i32]);
  const lastValue = fn("lastValue", [], [ext]);
  tx.freezeReservations();
  for (const token of [resolved, rejected]) tx.fillGlobal(token, [num(0)]);
  tx.fillGlobal(value, [{ op: "ref.null.extern" }]);
  for (const [callback, counter] of [
    [onResolve, resolved],
    [onReject, rejected],
  ] as const)
    tx.fillFunction(callback, {
      locals: [],
      body: [
        { op: "global.get", index: tx.physicalIndex(counter) },
        num(1),
        { op: "i32.add" },
        { op: "global.set", index: tx.physicalIndex(counter) },
        get(1),
        { op: "global.set", index: tx.physicalIndex(value) },
        get(1),
      ],
    });
  tx.fillFunction(resolve, { locals: [], body: buildPromiseSettleClosureBody(cap, onResolve.handle) });
  tx.fillFunction(reject, { locals: [], body: buildPromiseSettleClosureBody(cap, onReject.handle) });
  tx.fillFunction(pair, {
    locals: [
      { name: "promise", type: ref(promise) },
      { name: "guard", type: ref(guard) },
    ],
    body: [
      num(0),
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      num(0),
      { op: "struct.new", typeIdx: promise },
      { op: "local.set", index: 0 },
      num(0),
      { op: "struct.new", typeIdx: guard },
      { op: "local.set", index: 1 },
      ...buildPromiseSettleClosureValue(cap, resolve.handle, [get(0)], [get(1)]),
      { op: "extern.convert_any" },
      ...buildPromiseSettleClosureValue(cap, reject.handle, [get(0)], [get(1)]),
      { op: "extern.convert_any" },
    ],
  });
  for (const [invoke, target] of [
    [invokeResolve, resolve],
    [invokeReject, reject],
  ] as const)
    tx.fillFunction(invoke, {
      locals: [],
      body: [
        get(0),
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: rootType },
        get(1),
        { op: "call", funcIdx: target.handle },
      ],
    });
  tx.fillFunction(counts, {
    locals: [],
    body: [resolved, rejected].map((token) => ({ op: "global.get", index: tx.physicalIndex(token) })),
  });
  tx.fillFunction(lastValue, { locals: [], body: [{ op: "global.get", index: tx.physicalIndex(value) }] });
  for (const token of [resolve, reject]) tx.declareFunctionReference(token);
  for (const [name, token] of Object.entries({ pair, resolve: invokeResolve, reject: invokeReject, counts, lastValue }))
    tx.defineExport("export:" + name, name, token);
  tx.seal();
  const compiled = await WebAssembly.compile(Uint8Array.from(emitBinary(module)).buffer);
  return {
    compiled,
    exports: (await WebAssembly.instantiate(compiled, {})).exports as Record<string, CallableFunction>,
  };
}
