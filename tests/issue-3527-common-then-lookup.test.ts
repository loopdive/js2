// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import { buildCommonPromiseThenLookup } from "../src/runtime/wasmgc/promise/common-then-lookup-body.js";

// Recipe execution with observing imports. Real native producers are covered by full-realm-call.
function runtime() {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module),
    ext = { kind: "externref" } as const,
    i32 = { kind: "i32" } as const;
  const get = tx.reserveFunctionImport("get", "control", "get", {
    params: [ext, ext, ext],
    results: [ext],
  });
  const primitive = tx.reserveFunctionImport("primitive", "control", "primitive", { params: [ext], results: [i32] });
  const callable = tx.reserveFunctionImport("callable", "control", "callable", {
    params: [ext],
    results: [i32],
  });
  const undefinedValue = tx.reserveFunctionImport("undefined", "control", "undefined", { params: [], results: [ext] });
  const key = tx.reserveFunctionImport("key", "control", "key", {
    params: [],
    results: [ext],
  });
  const lookup = tx.reserveFunction("lookup", "lookup", {
    params: [ext],
    results: [i32, ext],
  });
  tx.freezeReservations();
  tx.fillFunction(
    lookup,
    buildCommonPromiseThenLookup(get.handle, primitive.handle, callable.handle, undefinedValue.handle, [
      { op: "call", funcIdx: key.handle },
    ]),
  );
  tx.defineExport("lookup-export", "lookup", lookup);
  tx.seal();
  const calls: unknown[][] = [];
  const control = {
    get(target: object, name: string, receiver: unknown) {
      calls.push([target, name, receiver]);
      return Reflect.get(target, name, receiver);
    },
    primitive(value: unknown) {
      return Number(value === null || (typeof value !== "object" && typeof value !== "function"));
    },
    callable(value: unknown) {
      return Number(typeof value === "function");
    },
    undefined: () => undefined,
    key: () => "then",
  };
  const api = new WebAssembly.Instance(new WebAssembly.Module(emitBinary(module) as BufferSource), { control }).exports;
  return { lookup: api.lookup as (value: unknown) => [number, unknown], calls };
}

it("does not read properties of any primitive resolution", () => {
  const { lookup, calls } = runtime();
  for (const value of [undefined, null, false, true, 0, NaN, 1n, "then", Symbol("then")])
    expect(lookup(value)).toEqual([0, undefined]);
  expect(calls).toEqual([]);
});

it("captures an inherited callable exactly once with the original receiver", () => {
  const { lookup, calls } = runtime();
  const first = () => {},
    later = () => {};
  let reads = 0;
  const parent = {
    get then() {
      expect(this).toBe(object);
      return ++reads === 1 ? first : later;
    },
  };
  const object = Object.create(parent);
  const result = lookup(object);
  expect(result).toEqual([1, first]);
  expect(reads).toBe(1);
  expect(calls).toEqual([[object, "then", object]]);
});

it("distinguishes a noncallable value and a missing property", () => {
  const { lookup } = runtime();
  const value = {};
  expect(lookup({ then: value })).toEqual([0, value]);
  expect(lookup({})).toEqual([0, undefined]);
});

it("preserves an abrupt getter result, including undefined", () => {
  const { lookup, calls } = runtime();
  for (const reason of [{ abrupt: true }, undefined]) {
    const value = {
      get then() {
        throw reason;
      },
    };
    let thrown = false;
    try {
      lookup(value);
    } catch (error) {
      thrown = true;
      expect(error).toBe(reason);
    }
    expect(thrown).toBe(true);
  }
  expect(calls).toHaveLength(2);
});
