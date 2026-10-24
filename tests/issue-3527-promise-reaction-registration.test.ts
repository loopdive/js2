// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { createNativePromiseShape } from "../src/runtime/wasmgc/promise/promise-layout.js";
import { buildPromiseReactionRegistration } from "../src/runtime/wasmgc/promise/reaction-registration-body.js";
import { buildPromiseSettleBody, buildPromiseSettleLocals } from "../src/runtime/wasmgc/promise/settlement-bodies.js";

// Registration and settlement are actual Wasm recipes. Imports observe the
// microtask boundary and handler calls; no assertion treats this as a full realm.
function runtime() {
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  const ext = { kind: "externref" } as const;
  const promise = tx.reserveType("promise", createNativePromiseShape());
  const ref = { kind: "ref", typeIdx: promise.typeIndex } as const;
  const callback = tx.reserveType("callback", {
    kind: "struct",
    name: "callback",
    fields: [
      { name: "fulfilled", type: { kind: "funcref" }, mutable: false },
      { name: "fulfilledCaptures", type: ext, mutable: false },
      { name: "rejected", type: { kind: "funcref" }, mutable: false },
      { name: "rejectedCaptures", type: ext, mutable: false },
      { name: "next", type: ext, mutable: false },
    ],
  });
  const handler = { params: [ext, ext], results: [ext] };
  const fulfilled = tx.reserveFunctionImport("fulfilled", "observe", "fulfilled", handler);
  const rejected = tx.reserveFunctionImport("rejected", "observe", "rejected", handler);
  const enqueue = tx.reserveFunctionImport("enqueue", "observe", "enqueue", {
    params: [{ kind: "funcref" }, ext, ext],
    results: [],
  });
  const handled = tx.reserveFunctionImport("handled", "observe", "handled", { params: [ref], results: [] });
  const make = tx.reserveFunction("make", "make", { params: [{ kind: "i32" }, ext], results: [ref] });
  const register = tx.reserveFunction("register", "register", { params: [ref, ext, ext], results: [] });
  const settle = [1, 2].map((state) =>
    tx.reserveFunction("settle" + state, "settle" + state, {
      params: [ref, ext],
      results: [ext],
    }),
  );
  tx.freezeReservations();
  const get = (index: number): Instr => ({ op: "local.get", index });
  tx.fillFunction(make, {
    locals: [],
    body: [
      get(0),
      get(1),
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "i32.const", value: 0 },
      { op: "struct.new", typeIdx: promise.typeIndex },
    ],
  });
  tx.fillFunction(register, {
    locals: [],
    body: buildPromiseReactionRegistration({
      promiseTypeIdx: promise.typeIndex,
      callbackTypeIdx: callback.typeIndex,
      promiseFields: { state: 0, value: 1, callbacks: 2 },
      promiseLocal: 0,
      fulfilled: { function: fulfilled.handle, capturesLocal: 1 },
      rejected: { function: rejected.handle, capturesLocal: 2 },
      enqueue: enqueue.handle,
      beforeRejected: [get(0), { op: "call", funcIdx: handled.handle }],
    }),
  });
  settle.forEach((token, index) =>
    tx.fillFunction(token, {
      locals: buildPromiseSettleLocals(callback.typeIndex),
      body: buildPromiseSettleBody(
        {
          promiseTypeIdx: promise.typeIndex,
          callbackTypeIdx: callback.typeIndex,
          enqueueFuncIdx: enqueue.handle,
          resolveHook: undefined,
          unhandledHeadGlobalIdx: -1,
          unhandledNodeTypeIdx: -1,
        },
        index === 0 ? 1 : 2,
      ),
    }),
  );
  tx.declareFunctionReference(fulfilled);
  tx.declareFunctionReference(rejected);
  for (const [name, token] of Object.entries({ make, register, fulfill: settle[0]!, reject: settle[1]! }))
    tx.defineExport("export:" + name, name, token);
  tx.seal();
  type Job = { fn: (capture: unknown, value: unknown) => unknown; capture: unknown; value: unknown };
  const jobs: Job[] = [],
    events: unknown[][] = [];
  const api = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(module) as BufferSource), {
    observe: {
      fulfilled(capture: unknown, value: unknown) {
        events.push(["fulfilled", capture, value]);
        return value;
      },
      rejected(capture: unknown, value: unknown) {
        events.push(["rejected", capture, value]);
        return value;
      },
      enqueue(fn: Job["fn"], capture: unknown, value: unknown) {
        events.push(["enqueue", capture, value]);
        jobs.push({ fn, capture, value });
      },
      handled(value: unknown) {
        events.push(["handled", value]);
      },
    },
  }).exports as Record<string, (...args: any[]) => any>;
  return {
    api,
    events,
    jobs,
    drain() {
      for (const { fn, capture, value } of jobs.splice(0)) fn(capture, value);
    },
  };
}

describe("shared Promise reaction registration", () => {
  for (const state of [1, 2]) {
    it(`queues the matching settled reaction with capture identity (state=${state})`, () => {
      const r = runtime(),
        value = {},
        f = {},
        j = {};
      const promise = r.api.make(state, value);
      r.api.register(promise, f, j);
      expect(r.jobs).toHaveLength(1);
      expect(r.jobs[0]!.capture).toBe(state === 1 ? f : j);
      expect(r.jobs[0]!.value).toBe(value);
      expect(r.events).toEqual(
        state === 1
          ? [["enqueue", f, value]]
          : [
              ["handled", promise],
              ["enqueue", j, value],
            ],
      );
      r.drain();
      expect(r.events.at(-1)).toEqual([state === 1 ? "fulfilled" : "rejected", state === 1 ? f : j, value]);
    });
    it(`retains all pending reactions in registration order on settlement (state=${state})`, () => {
      const r = runtime(),
        promise = r.api.make(0, null),
        value = {};
      const captures = Array.from({ length: 3 }, (_, index) => ({
        f: { index, kind: "fulfill" },
        j: { index, kind: "reject" },
      }));
      for (const { f, j } of captures) r.api.register(promise, f, j);
      expect(r.events).toEqual([]);
      r.api[state === 1 ? "fulfill" : "reject"](promise, value);
      expect(r.jobs.map((job) => job.capture)).toEqual(captures.map((c) => (state === 1 ? c.f : c.j)));
      expect(r.jobs).toHaveLength(captures.length);
      r.jobs.forEach((job, index) => {
        expect(job.capture).toBe(state === 1 ? captures[index]!.f : captures[index]!.j);
        expect(job.value).toBe(value);
      });
      r.drain();
      expect(r.events.slice(3)).toEqual(
        captures.map((c) => [state === 1 ? "fulfilled" : "rejected", state === 1 ? c.f : c.j, value]),
      );
      r.events.slice(3).forEach((event, index) => {
        expect(event[1]).toBe(state === 1 ? captures[index]!.f : captures[index]!.j);
        expect(event[2]).toBe(value);
      });
      r.events.length = 0;
      r.api.fulfill(promise, "second settlement");
      r.api.reject(promise, "second settlement");
      expect(r.events).toEqual([]);
      r.api.register(promise, "late fulfillment", "late rejection");
      expect(r.jobs).toHaveLength(1);
      expect(r.jobs[0]!.value).toBe(value);
    });
  }
});
