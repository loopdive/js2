// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import type { ImportDescriptor } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import {
  createScalarHostAsyncImportAdapters,
  HostAsyncReplayValueUnsupportedError,
  type HostAsyncImportAdapters,
  type HostAsyncPromiseBuiltinName,
} from "../src/runtime/host-async-imports.js";
import { createHostImportCallState } from "../src/runtime/host-import-call-state.js";

type Lane = "facade" | "scalar replay";
const lanes: readonly Lane[] = ["facade", "scalar replay"];
const builtins: readonly HostAsyncPromiseBuiltinName[] = [
  "Promise_resolve",
  "Promise_new_pending",
  "Promise_settle_resolve",
  "Promise_settle_reject",
  "Promise_then",
  "Promise_then2",
  "Promise_then2_frame",
];

function facade() {
  const manifest: ImportDescriptor[] = builtins.map((name) => ({
    module: "env",
    kind: "func",
    name,
    intent: { type: "builtin", name },
  }));
  manifest.push(
    { module: "env", kind: "func", name: "caught", intent: { type: "caught_exception" }, paramCount: 0 },
    { module: "env", kind: "func", name: "box", intent: { type: "box", targetType: "number" }, paramCount: 1 },
    { module: "env", kind: "func", name: "unbox", intent: { type: "unbox", targetType: "number" }, paramCount: 1 },
    { module: "env", kind: "func", name: "callback", intent: { type: "callback_maker" }, paramCount: 2 },
    {
      module: "env",
      kind: "func",
      name: "constructible",
      intent: { type: "callback_maker", constructible: true },
      paramCount: 2,
    },
    {
      module: "env",
      kind: "func",
      name: "undefined",
      intent: { type: "builtin", name: "__get_undefined" },
      paramCount: 0,
    },
  );
  return buildImports(manifest);
}

function adapters(lane: Lane): HostAsyncImportAdapters {
  if (lane === "scalar replay") return createScalarHostAsyncImportAdapters();
  const { env } = facade();
  return {
    caughtException: () => env.caught!,
    callbackMaker: (constructible = false) => env[constructible ? "constructible" : "callback"]!,
    boxNumber: () => env.box!,
    unboxNumber: () => env.unbox!,
    undefinedValue: () => env.undefined!,
    promiseBuiltin: (name) => env[name]!,
  };
}

/** A real externref callback and real exported exception tag; no compiler or source handler. */
function callbackInstance(throws: boolean) {
  const name = (value: string): number[] => [value.length, ...new TextEncoder().encode(value)];
  const section = (id: number, bytes: number[]): number[] => [id, bytes.length, ...bytes];
  const body = throws ? [0, 0x20, 1, 0x08, 0, 0x0b] : [0, 0x20, 0, 0x0b];
  const binary = new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [2, 0x60, 2, 0x6f, 0x6f, 1, 0x6f, 0x60, 1, 0x6f, 0]),
    ...section(2, [1, ...name("env"), ...name("tag"), 4, 0, 1]),
    ...section(3, [1, 0]),
    ...section(7, [2, ...name("__cb_7"), 0, 0, ...name("__exn_tag"), 4, 0]),
    ...section(10, [1, body.length, ...body]),
  ]);
  expect(WebAssembly.validate(binary)).toBe(true);
  const tag = new WebAssembly.Tag({ parameters: ["externref"] });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), { env: { tag } });
  return { instance, tag };
}

function callbackAdapter(lane: Lane, instance: WebAssembly.Instance) {
  if (lane === "facade") {
    const imports = facade();
    expect(imports.setInstance).toBeTypeOf("function");
    imports.setInstance!(instance);
    return (constructible = false) => imports.env[constructible ? "constructible" : "callback"]!;
  }
  const exports: Record<string, any> = instance.exports;
  const imported = createScalarHostAsyncImportAdapters({ getExports: () => exports });
  return imported.callbackMaker;
}

describe("shared host async handlers and scalar replay boundary", () => {
  it.each(lanes)("%s keeps a real pending Promise and asynchronous settlement", async (lane) => {
    const imported = adapters(lane);
    const pending = imported.promiseBuiltin("Promise_new_pending")();
    expect(pending).toBeInstanceOf(Promise);
    expect(pending.__r).toBeTypeOf("function");
    expect(pending.__j).toBeTypeOf("function");
    const phases = ["created"];
    const observed = pending.then((value: number) => {
      phases.push("reaction");
      return value;
    });
    imported.promiseBuiltin("Promise_settle_resolve")(pending, 42);
    phases.push("settled");
    expect(phases).toEqual(["created", "settled"]);
    await expect(observed).resolves.toBe(42);
    expect(phases).toEqual(["created", "settled", "reaction"]);
  });

  it.each(lanes)("%s preserves exact rejection objects and live capability receivers", async (lane) => {
    const imported = adapters(lane);
    const reason = { reason: 3518 };
    const pending = imported.promiseBuiltin("Promise_new_pending")();
    const observation = expect(pending).rejects.toBe(reason);
    imported.promiseBuiltin("Promise_settle_reject")(pending, reason);
    await observation;
    const receivers: unknown[] = [];
    const capability = {
      __r(this: unknown, value: unknown) {
        receivers.push(this, value);
      },
    };
    imported.promiseBuiltin("Promise_settle_resolve")(capability, 42);
    expect(receivers).toEqual([capability, 42]);
  });

  it.each(lanes)("%s uses live then dispatch and the Promise species constructor", async (lane) => {
    class Derived extends Promise<number> {}
    class Source extends Promise<number> {
      static get [Symbol.species]() {
        return Derived;
      }
    }
    const imported = adapters(lane);
    const source = new Source((resolve) => resolve(20));
    const derived = imported.promiseBuiltin("Promise_then")(source, (value: number) => value + 22);
    expect(derived).toBeInstanceOf(Derived);
    await expect(derived).resolves.toBe(42);
    const events: unknown[] = [];
    const live = {
      then(this: unknown, fulfill: (value: number) => number, reject: unknown) {
        events.push(this, reject);
        return fulfill(40);
      },
    };
    expect(imported.promiseBuiltin("Promise_then2")(live, (value: number) => value + 2, null)).toBe(42);
    expect(events).toEqual([live, null]);
  });

  it.each(lanes)("%s preserves function-thenable assimilation order", async (lane) => {
    const phases = ["start"];
    const thenable = Object.assign(function value() {}, {
      then(resolve: (value: number) => void) {
        phases.push("then");
        resolve(42);
      },
    });
    const promise = adapters(lane).promiseBuiltin("Promise_resolve")(thenable);
    phases.push("returned");
    expect(phases).toEqual(["start", "returned"]);
    await expect(promise).resolves.toBe(42);
    expect(phases).toEqual(["start", "returned", "then"]);
  });

  it.each(lanes)("%s forwards primitive number and undefined behavior", (lane) => {
    const imported = adapters(lane);
    for (const value of [0, -0, 42, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(Object.is(imported.boxNumber()(value), value)).toBe(true);
      expect(Object.is(imported.unboxNumber()(value), value)).toBe(true);
    }
    expect(imported.unboxNumber()("42")).toBe(42);
    expect(imported.unboxNumber()(null)).toBe(0);
    expect(imported.unboxNumber()(17n)).toBe(17);
    expect(imported.unboxNumber()(undefined)).toBeNaN();
    expect(() => imported.unboxNumber()(Symbol("number"))).toThrow(TypeError);
    expect(imported.undefinedValue()()).toBeUndefined();
  });

  it.each(lanes)("%s dispatches an actual Wasm callback with capture identity and constructibility", (lane) => {
    const { instance } = callbackInstance(false);
    const maker = callbackAdapter(lane, instance);
    const capture = { capture: 3518 };
    const callback = maker()(7, capture);
    expect(callback("ignored")).toBe(capture);
    expect(String(callback)).toBe("function () { [native code] }");
    expect(() => Reflect.construct(callback, [])).toThrow(TypeError);
    expect(Reflect.construct(maker(true)(7, capture), [])).toBe(capture);
  });

  it.each(lanes)("%s unwraps an actual module tag while preserving foreign payload identity", async (lane) => {
    const { instance, tag } = callbackInstance(true);
    const callback = callbackAdapter(lane, instance)()(7, null);
    const foreignTag = new WebAssembly.Tag({ parameters: ["externref"] });
    const foreign = new WebAssembly.Exception(foreignTag, ["foreign"]);
    expect(foreign.is(tag)).toBe(false);
    for (const reason of [{ identity: 3518 }, null, undefined, Symbol("reason"), foreign]) {
      await expect(adapters(lane).promiseBuiltin("Promise_then")(Promise.resolve(reason), callback)).rejects.toBe(
        reason,
      );
    }
  });

  it.each(lanes)("%s rejects the frame Promise with the original callback trap", async (lane) => {
    const imported = adapters(lane);
    const pending = imported.promiseBuiltin("Promise_new_pending")();
    const trap = new WebAssembly.RuntimeError("retained trap");
    const observed = expect(pending).rejects.toBe(trap);
    const derivative = imported.promiseBuiltin("Promise_then2_frame")(
      Promise.resolve(1),
      () => {
        throw trap;
      },
      undefined,
      pending,
    );
    await observed;
    await expect(derivative).resolves.toBeUndefined();
  });

  it("keeps facade object thenables and native Promise identity", async () => {
    const resolve = adapters("facade").promiseBuiltin("Promise_resolve");
    const native = Promise.resolve(42);
    expect(resolve(native)).toBe(native);
    const events: unknown[] = [];
    const thenable = {
      get then() {
        events.push("get");
        return function (this: unknown, fulfill: (value: number) => void) {
          events.push(this);
          fulfill(42);
        };
      },
    };
    const promise = resolve(thenable);
    expect(events).toEqual(["get"]);
    await expect(promise).resolves.toBe(42);
    expect(events).toEqual(["get", thenable]);
    const imported = adapters("facade");
    const pending = imported.promiseBuiltin("Promise_new_pending")();
    const object = { fulfilled: 3518 };
    imported.promiseBuiltin("Promise_settle_resolve")(pending, object);
    await expect(pending).resolves.toBe(object);
  });

  it("keeps the facade object number walker and per-instance caught identity", () => {
    const first = facade();
    const second = facade();
    const reason = { thrown: 3518 };
    let calls = 0;
    const value = {
      [Symbol.toPrimitive]() {
        calls++;
        throw reason;
      },
    };
    let caught: unknown;
    try {
      first.env.unbox!(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
    expect(calls).toBe(1);
    expect(first.env.caught!()).toBe(reason);
    expect(second.env.caught!()).toBeUndefined();
    expect(first.env.unbox!(43)).toBe(43);
    expect(first.env.caught!()).toBe(reason);
  });

  it.each(["resolve", "unbox", "callback"] as const)(
    "refuses scalar replay %s objects before probing them",
    (operation) => {
      let reads = 0;
      const value = new Proxy(
        {},
        {
          get() {
            reads++;
            throw new Error("must not probe");
          },
        },
      );
      const imported = createScalarHostAsyncImportAdapters();
      const action =
        operation === "resolve"
          ? () => imported.promiseBuiltin("Promise_resolve")(value)
          : operation === "unbox"
            ? () => imported.unboxNumber()(value)
            : () => imported.promiseBuiltin("Promise_then")(Promise.resolve(1), value);
      expect(action).toThrow(HostAsyncReplayValueUnsupportedError);
      expect(reads).toBe(0);
    },
  );

  it("refuses an object reaction result through the existing frame rejection edge", async () => {
    const imported = createScalarHostAsyncImportAdapters();
    const pending = imported.promiseBuiltin("Promise_new_pending")();
    const observation = expect(pending).rejects.toMatchObject({
      code: "unsupported-host-async-replay-value",
      operation: "async.promise.react.result",
    });
    const derivative = imported.promiseBuiltin("Promise_then2_frame")(Promise.resolve(1), () => ({}), null, pending);
    await observation;
    await expect(derivative).resolves.toBeUndefined();
  });

  it("refuses object fulfillment before reading the capability, while retaining object rejection", async () => {
    const imported = createScalarHostAsyncImportAdapters();
    let reads = 0;
    const capability = {
      get __r() {
        reads++;
        throw new Error("must refuse before capability access");
      },
    };
    const reason = { identity: 3518 };
    expect(() => imported.promiseBuiltin("Promise_settle_resolve")(capability, reason)).toThrow(
      HostAsyncReplayValueUnsupportedError,
    );
    expect(reads).toBe(0);
    const pending = imported.promiseBuiltin("Promise_new_pending")();
    const observation = expect(pending).rejects.toBe(reason);
    imported.promiseBuiltin("Promise_settle_reject")(pending, reason);
    await observation;
  });

  it.each([-2, -1])("refuses the scalar replay legacy void callback sentinel %i", (id) => {
    expect(() => createScalarHostAsyncImportAdapters().callbackMaker()(id, {})).toThrow(
      HostAsyncReplayValueUnsupportedError,
    );
  });

  it("rejects an unknown builtin name instead of treating it as a frame reaction", () => {
    expect(() =>
      Reflect.apply(createScalarHostAsyncImportAdapters().promiseBuiltin, undefined, ["Promise_unknown"]),
    ).toThrow("unsupported host async Promise builtin");
  });

  it("keeps late exports and start-section callback dispatch on the canonical bridge", () => {
    const { instance } = callbackInstance(false);
    const state: { exports?: Record<string, any> } = {};
    const queued: (() => void)[] = [];
    const imported = createScalarHostAsyncImportAdapters({
      getExports: () => state.exports,
      deferToExports: (callback) => queued.push(callback),
    });
    const capture = { late: 3518 };
    const callback = imported.callbackMaker()(7, capture);
    expect(callback()).toBeUndefined();
    expect(queued).toHaveLength(1);
    state.exports = instance.exports;
    queued[0]!();
    expect(callback()).toBe(capture);
    const start = createScalarHostAsyncImportAdapters({
      getExports: () => undefined,
      getStartExports: () => instance.exports as Record<string, any>,
      deferToExports: () => {
        throw new Error("start callback must dispatch synchronously");
      },
    });
    expect(start.callbackMaker()(7, capture)()).toBe(capture);
  });

  it("reads the facade constructibility intent at each callback invocation", () => {
    const { instance } = callbackInstance(false);
    const intent = { type: "callback_maker" as const, constructible: false };
    const imports = buildImports([{ module: "env", kind: "func", name: "callback", intent, paramCount: 2 }]);
    imports.setInstance!(instance);
    const capture = { live: 3518 };
    const before = imports.env.callback!(7, capture);
    expect(() => Reflect.construct(before, [])).toThrow(TypeError);
    intent.constructible = true;
    const during = imports.env.callback!(7, capture);
    expect(Reflect.construct(during, [])).toBe(capture);
    intent.constructible = false;
    const after = imports.env.callback!(7, capture);
    expect(() => Reflect.construct(after, [])).toThrow(TypeError);
    expect(Reflect.construct(during, [])).toBe(capture);
  });
});

describe("shared import call-state lifecycle", () => {
  it.each([0, 1, 2, 3, 4, 5, undefined])("preserves actual argument count and captured errors at arity %s", (arity) => {
    const state = createHostImportCallState();
    const imp = { name: "probe", paramCount: arity, intent: { type: "declared_func" } };
    const args = [10, 20, 30, 40, 50, 60];
    const reason = { arity };
    const seen: unknown[][] = [];
    const fn = state.wrap(
      imp,
      (...values: unknown[]) => {
        seen.push(values);
        throw reason;
      },
      state.registerImport(imp.name),
    ).fn;
    let caught: unknown;
    try {
      fn(...args);
    } catch (error) {
      caught = error;
    }
    expect(seen).toEqual([arity === undefined || arity > 4 ? args : args.slice(0, arity)]);
    expect(caught).toBe(reason);
    expect(state.getCaughtException()).toBe(reason);
  });

  it("shares one recursion counter, retains the overflow object, and recovers after unwinding", () => {
    const state = createHostImportCallState();
    const imp = { name: "recursive", paramCount: 1, intent: { type: "declared_func" } };
    const index = state.registerImport(imp.name);
    const recursive: Function = state.wrap(
      imp,
      (remaining: number): number => (remaining === 0 ? 42 : recursive(remaining - 1)),
      index,
    ).fn;
    expect(recursive(511)).toBe(42);
    expect(() => recursive(512)).toThrow("Maximum call stack size exceeded");
    const caught = state.getCaughtException();
    expect(caught).toBeInstanceOf(RangeError);
    expect(recursive(2)).toBe(42);
    expect(state.getCaughtException()).toBe(caught);
    expect(createHostImportCallState().getCaughtException()).toBeUndefined();
  });

  it("retains resettable import counts including fixed leaf wrappers", () => {
    const state = createHostImportCallState();
    const box = { name: "box", paramCount: 1, intent: { type: "box" } };
    const undef = { name: "undefined", paramCount: 0, intent: { type: "builtin", name: "__get_undefined" } };
    const a = state.wrap(box, (value: number) => value, state.registerImport(box.name));
    const b = state.wrap(undef, () => undefined, state.registerImport(undef.name));
    expect(a.fn.length).toBe(1);
    expect(b.fn.length).toBe(0);
    expect(a.fn(42)).toBe(42);
    state.startImportCounting();
    a.fn(1);
    a.fn(2);
    b.fn();
    const counts = state.takeImportCounts();
    expect(Object.getPrototypeOf(counts)).toBeNull();
    expect(counts).toEqual({ box: 2, undefined: 1 });
    a.fn(3);
    expect(state.takeImportCounts()).toEqual({});
    state.startImportCounting();
    b.fn();
    expect(state.takeImportCounts()).toEqual({ undefined: 1 });
  });
});
