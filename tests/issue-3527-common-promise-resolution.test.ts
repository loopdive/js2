// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, ValType } from "../src/wasm/model/instructions.js";
import { createNativePromiseShape } from "../src/runtime/wasmgc/promise/promise-layout.js";
import {
  buildNativePromiseResolveValueBody,
  buildPromiseResolveValueBody,
  buildPromiseResolveValueLocals,
  type PromiseResolveValueResources,
} from "../src/runtime/wasmgc/promise/resolution-bodies.js";

// Execute the real resolution recipe. Imports observe lookup, settlement and queue
// boundaries; this fixture does not certify the public Promise runtime or real Get.
function runtime() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const ext = { kind: "externref" } as const,
    i32 = { kind: "i32" } as const;
  const get = (index: number): Instr => ({ op: "local.get", index });
  const nil: Instr = { op: "ref.null.extern" };
  const promise = tx.reserveType("promise", createNativePromiseShape());
  const ref = { kind: "ref", typeIdx: promise.typeIndex } as const;
  const caps = tx.reserveType("caps", {
    name: "caps",
    kind: "struct",
    fields: [
      { name: "callback", type: ext, mutable: false },
      { name: "chained", type: ref, mutable: false },
    ],
  });
  const callback = tx.reserveType("callback", {
    name: "callback",
    kind: "struct",
    fields: [
      { name: "fulfilled", type: { kind: "funcref" }, mutable: false },
      { name: "fulfilledCaps", type: ext, mutable: false },
      { name: "rejected", type: { kind: "funcref" }, mutable: false },
      { name: "rejectedCaps", type: ext, mutable: false },
      { name: "next", type: ext, mutable: false },
    ],
  });
  const imported = (name: string, params: ValType[], results: ValType[]) =>
    tx.reserveFunctionImport(name, "control", name, { params, results });
  const lookup = imported("lookup", [ext], [i32, ext]);
  const fulfill = imported("fulfill", [ref, ext], [ext]);
  const reject = imported("reject", [ref, ext], [ext]);
  const enqueue = imported("enqueue", [{ kind: "funcref" }, ext, ext], []);
  const peel = imported("peel", [ext], [ext]);
  const error = imported("typeError", [ext], [ext]);
  const job = imported("job", [ext, ext], [ext]);
  const classifier = imported("classifier", [ext], [i32]);
  const bag = imported("bag", [ext, ext], [i32]);
  const oldGet = imported("oldGet", [ext, ext], [ext]);
  const exception = tx.reserveTag("exception", { params: [ext], results: [] }, { kind: "defined", name: "exception" });
  const resolve = tx.reserveFunction("resolve", "resolve", { params: [ref, ext], results: [ext] });
  const make = tx.reserveFunction("make", "make", { params: [i32, ext], results: [ext] });
  const captured = tx.reserveFunction("captured", "captured", { params: [ext], results: [ext] });
  tx.freezeReservations();
  const resources: PromiseResolveValueResources & { thenable: NonNullable<PromiseResolveValueResources["thenable"]> } =
    {
      resolutionMode: "common-get",
      target: { standalone: true, wasi: false },
      promiseTypeIdx: promise.typeIndex,
      callbackTypeIdx: callback.typeIndex,
      capsTypeIdx: caps.typeIndex,
      promiseFields: { state: 0, value: 1, callbacks: 2 },
      callbackFields: [0, 1, 2, 3, 4],
      capsFields: { callback: 0, chained: 1 },
      exnTagIdx: tx.physicalIndex(exception),
      state: {
        promiseFulfillFuncIdx: fulfill.handle,
        promiseRejectFuncIdx: reject.handle,
        enqueueFuncIdx: enqueue.handle,
        identityFulfillWrapperFuncIdx: job.handle,
        identityRejectWrapperFuncIdx: job.handle,
      },
      thenable: {
        lookupThenFuncIdx: lookup.handle,
        hasCallableThenFuncIdx: classifier.handle,
        thenableJobFuncIdx: job.handle,
        peelValueFuncIdx: peel.handle,
        newTypeErrorFuncIdx: error.handle,
      },
      selfResolutionStringInstrs: [nil],
      thenStringInstrs: [nil],
      thenGetStringInstrs: [nil],
      bagHasIdx: bag.handle,
      externGetIdx: oldGet.handle,
      typeofFunctionIdx: classifier.handle,
      callableRootTypeIdx: undefined,
    };
  tx.fillFunction(resolve, {
    locals: buildPromiseResolveValueLocals(promise.typeIndex),
    body: buildNativePromiseResolveValueBody(resources),
  });
  tx.fillFunction(make, {
    locals: [],
    body: [
      get(0),
      get(1),
      nil,
      nil,
      { op: "i32.const", value: 0 },
      { op: "struct.new", typeIdx: promise.typeIndex },
      { op: "extern.convert_any" },
    ],
  });
  tx.fillFunction(captured, {
    locals: [],
    body: [
      get(0),
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: caps.typeIndex },
      { op: "struct.get", typeIdx: caps.typeIndex, fieldIdx: 0 },
    ],
  });
  tx.declareFunctionReference(job);
  for (const [name, token] of Object.entries({ resolve, make, captured, exception }))
    tx.defineExport("export:" + name, name, token);
  tx.seal();
  const events: unknown[][] = [];
  const state = { callable: 0, then: {} as unknown, throws: false, reason: {}, selfError: {} };
  const forbidden = () => {
    throw Error("legacy dispatch must not execute");
  };
  const api: Record<string, any> = new WebAssembly.Instance(
    new WebAssembly.Module(emitBinary(module) as BufferSource),
    {
      control: {
        lookup(value: unknown) {
          events.push(["get", value]);
          if (state.throws) throw new WebAssembly.Exception(api.exception, [state.reason]);
          return [state.callable, state.then];
        },
        fulfill(target: unknown, value: unknown) {
          events.push(["fulfill", target, value]);
          return value;
        },
        reject(target: unknown, value: unknown) {
          events.push(["reject", target, value]);
          return value;
        },
        enqueue(fn: unknown, capture: unknown, value: unknown) {
          events.push(["enqueue", fn, capture, value]);
        },
        peel: (value: unknown) => value,
        typeError() {
          events.push(["typeError"]);
          return state.selfError;
        },
        job(capture: unknown, value: unknown) {
          events.push(["job", capture, value]);
          return value;
        },
        classifier: forbidden,
        bag: forbidden,
        oldGet: forbidden,
      },
    },
  ).exports;
  return { api, events, state, resources };
}

describe("native common-Get resolution mode", () => {
  it("uses one lookup for ordinary values and every native Promise state, without direct adoption", () => {
    const r = runtime();
    for (const value of [{ ordinary: true }, ...[0, 1, 2].map((state) => r.api.make(state, "inner value"))]) {
      const target = r.api.make(0, null);
      r.events.length = 0;
      expect(r.api.resolve(target, value)).toBe(value);
      expect(r.events).toEqual([
        ["get", value],
        ["fulfill", target, value],
      ]);
    }
  });
  it("captures once and queues without invoking then inline or rereading after mutation", () => {
    const r = runtime(),
      target = r.api.make(0, null),
      value = r.api.make(1, 99),
      originalThen = {};
    r.state.callable = 1;
    r.state.then = originalThen;
    expect(r.api.resolve(target, value)).toBe(value);
    expect(r.events.map((event) => event[0])).toEqual(["get", "enqueue"]);
    const queued = r.events[1]!;
    r.state.then = {};
    expect(r.api.captured(queued[2])).toBe(originalThen);
    expect(queued[3]).toBe(value);
  });
  it("rejects the exact thrown getter value for native and ordinary objects", () => {
    const r = runtime();
    r.state.throws = true;
    for (const value of [{}, r.api.make(2, "inner rejection")]) {
      const target = r.api.make(0, null);
      r.events.length = 0;
      expect(r.api.resolve(target, value)).toBe(r.state.reason);
      expect(r.events).toEqual([
        ["get", value],
        ["reject", target, r.state.reason],
      ]);
    }
  });
  it("rejects self-resolution before reading then", () => {
    const r = runtime(),
      target = r.api.make(0, null);
    expect(r.api.resolve(target, target)).toBe(target);
    expect(r.events).toEqual([["typeError"], ["reject", target, r.state.selfError]]);
  });
  it("requires an explicit own data mode and leaves default output unchanged under inherited pollution", () => {
    const { resources } = runtime();
    const { resolutionMode: _mode, ...legacy } = resources;
    const expected = buildPromiseResolveValueBody(legacy);
    let reads = 0;
    const saved = Object.getOwnPropertyDescriptor(Object.prototype, "resolutionMode");
    try {
      Object.defineProperty(Object.prototype, "resolutionMode", {
        configurable: true,
        get() {
          reads++;
          throw Error("must not read");
        },
      });
      const actual = buildPromiseResolveValueBody(legacy);
      Reflect.deleteProperty(Object.prototype, "resolutionMode");
      expect(actual).toEqual(expected);
      const bad = { ...legacy };
      Object.defineProperty(bad, "resolutionMode", {
        enumerable: true,
        get() {
          reads++;
          return "common-get";
        },
      });
      expect(() => buildPromiseResolveValueBody(bad)).toThrow(/explicit common-Get/);
      expect(reads).toBe(0);
      expect(() => buildPromiseResolveValueBody({ ...resources, thenable: null })).toThrow(/native bindings/);
    } finally {
      if (saved) Object.defineProperty(Object.prototype, "resolutionMode", saved);
      else Reflect.deleteProperty(Object.prototype, "resolutionMode");
    }
  });
});
