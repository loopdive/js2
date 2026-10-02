// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { setImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { freezePreparedIrRuntimeValue, preparedIrDataMismatch } from "../src/ir/program/data.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations, type PhysicalReservation } from "../src/wasm/physical/module-reservations.js";

afterEach(async () => await setImmediate());

describe("collection-slot caching preserves fresh data authentication", () => {
  it.each(["value", "negative-zero", "undefined", "hidden", "symbol", "prototype", "accessor", "function"])(
    "detects %s changes after repeatedly comparing the same object identities",
    (change) => {
      const make = () => ({ nested: { value: 1 }, zero: -0, optional: undefined });
      const before = make(),
        after = make();
      for (let repeat = 0; repeat < 3; repeat++) expect(preparedIrDataMismatch(before, after)).toBeUndefined();
      let getters = 0;
      switch (change) {
        case "value":
          after.nested.value = 2;
          break;
        case "negative-zero":
          after.zero = 0;
          break;
        case "undefined":
          Reflect.deleteProperty(after, "optional");
          break;
        case "hidden":
          Object.defineProperty(after, "hidden", { value: undefined });
          break;
        case "symbol":
          Object.defineProperty(after, Symbol("field"), { value: 1 });
          break;
        case "prototype":
          Object.setPrototypeOf(after.nested, { marker: 1 });
          break;
        case "accessor":
          Object.defineProperty(after.nested, "value", {
            get() {
              getters++;
              return 1;
            },
          });
          break;
        case "function":
          Object.defineProperty(after.nested, "value", { value: () => 1 });
          break;
      }
      expect(preparedIrDataMismatch(before, after)).toBeDefined();
      expect(getters).toBe(0);
    },
  );

  it("rewalks warmed symbol/hidden fields and ordered native collection entries", () => {
    const symbol = Symbol("same key"),
      before = {},
      after = {};
    for (const object of [before, after]) {
      Object.defineProperty(object, "hidden", { value: 1, writable: true });
      Object.defineProperty(object, symbol, { value: 2, writable: true });
    }
    expect(preparedIrDataMismatch(before, after)).toBeUndefined();
    Object.defineProperty(after, symbol, { value: 3 });
    expect(preparedIrDataMismatch(before, after)).toContain("Symbol(same key)");
    Object.defineProperty(after, symbol, { value: 2 });
    Object.defineProperty(after, "hidden", { value: 3 });
    expect(preparedIrDataMismatch(before, after)).toBe("$root.hidden");
    const map = new Map([
      ["a", { value: 1 }],
      ["b", { value: 2 }],
    ]);
    const other = new Map([
      ["a", { value: 1 }],
      ["b", { value: 2 }],
    ]);
    expect(preparedIrDataMismatch(map, other)).toBeUndefined();
    other.get("a")!.value = 9;
    expect(preparedIrDataMismatch(map, other)).toContain(".entries");
    other.set("a", { value: 1 });
    expect(preparedIrDataMismatch(map, other)).toBeUndefined();
    other.delete("a");
    other.set("a", { value: 1 });
    expect(preparedIrDataMismatch(map, other)).toContain(".entries");
    const set = new Set([1, 2]),
      otherSet = new Set([1, 2]);
    expect(preparedIrDataMismatch(set, otherSet)).toBeUndefined();
    otherSet.delete(1);
    otherSet.add(1);
    expect(preparedIrDataMismatch(set, otherSet)).toContain(".values");
  });

  for (const kind of ["Map", "Set", "WeakMap", "WeakSet"] as const)
    for (const foreign of [false, true])
      for (const prototype of [null, Object.prototype])
        it(`retains ${foreign ? "foreign" : "local"} ${kind} slots with ${prototype === null ? "null" : "Object"} prototype`, () => {
          const factories = {
            Map: () => new Map(),
            Set: () => new Set(),
            WeakMap: () => new WeakMap(),
            WeakSet: () => new WeakSet(),
          };
          const value = foreign ? (runInNewContext(`new ${kind}()`) as object) : factories[kind]();
          // All are empty: a successful native has probe returns false, but still proves a slot.
          Object.setPrototypeOf(value, prototype);
          for (let repeat = 0; repeat < 3; repeat++) {
            expect(preparedIrDataMismatch(value, value)).toBe("$root (non-data object)");
            expect(() => freezePreparedIrRuntimeValue(value)).toThrow("mutable or executable context state");
          }
        });

  it("does not treat tags or prototype changes as cached collection authority", () => {
    const left = { [Symbol.toStringTag]: "Map" },
      right = { [Symbol.toStringTag]: "Map" };
    expect(preparedIrDataMismatch(left, right)).toBeUndefined();
    let getters = 0;
    Object.defineProperty(right, Symbol.toStringTag, {
      get() {
        getters++;
        return "Map";
      },
    });
    expect(preparedIrDataMismatch(left, right)).toContain("Symbol(Symbol.toStringTag)");
    expect(getters).toBe(0);
    Object.defineProperty(right, Symbol.toStringTag, { value: "Map" });
    Object.setPrototypeOf(right, { [Symbol.toStringTag]: "Map" });
    expect(preparedIrDataMismatch(left, right)).toBe("$root (non-data object)");
  });

  it("rewalks proxy targets and refuses revocation after a successful comparison", () => {
    const target = { value: 1 },
      before = { value: 1 };
    const { proxy, revoke } = Proxy.revocable(target, {});
    expect(preparedIrDataMismatch(before, proxy)).toBeUndefined();
    target.value = 2;
    expect(preparedIrDataMismatch(before, proxy)).toBe("$root.value");
    target.value = 1;
    expect(preparedIrDataMismatch(before, proxy)).toBeUndefined();
    revoke();
    expect(() => preparedIrDataMismatch(before, proxy)).toThrow(TypeError);
    const wrappedCollection = new Proxy(new Map(), {});
    Object.setPrototypeOf(wrappedCollection, null);
    // A proxy has no collection slots of its own; its mutable target is not cached data.
    expect(preparedIrDataMismatch(wrappedCollection, {})).toBeUndefined();
    Object.defineProperty(wrappedCollection, "value", { value: 1 });
    expect(preparedIrDataMismatch(wrappedCollection, {})).toBe("$root (field population)");
  });

  it("uses captured probes and private cache dispatch after public intrinsic replacement", () => {
    const warm = {},
      cold = {},
      hidden = [new Map(), new Set(), new WeakMap(), new WeakSet()];
    expect(preparedIrDataMismatch(warm, {})).toBeUndefined();
    for (const value of hidden) Object.setPrototypeOf(value, null);
    const targets = new Set<object>([warm, cold, ...hidden]);
    const apply = Reflect.apply,
      setHas = Set.prototype.has;
    const replacements: [object, PropertyKey, PropertyDescriptor][] = [];
    let calls = 0,
      rejected = 0;
    const replace = (owner: object, key: PropertyKey, value: unknown) => {
      replacements.push([owner, key, Object.getOwnPropertyDescriptor(owner, key)!]);
      Object.defineProperty(owner, key, { ...replacements.at(-1)![2], value });
    };
    let result: unknown;
    try {
      for (const prototype of [Map.prototype, Set.prototype, WeakMap.prototype, WeakSet.prototype])
        replace(prototype, "has", function (this: object, key: unknown) {
          if (apply(setHas, targets, [this])) {
            calls++;
            return false;
          }
          if (prototype === Set.prototype) return apply(setHas, this, [key]);
          throw Error("replaced probe called");
        });
      for (const key of ["get", "set"])
        replace(WeakMap.prototype, key, () => {
          throw Error("replaced cache dispatch called");
        });
      replace(Reflect, "apply", () => {
        throw Error("replaced Reflect.apply called");
      });
      result = freezePreparedIrRuntimeValue({ warm, cold });
      for (const value of hidden) {
        try {
          freezePreparedIrRuntimeValue(value);
        } catch (error) {
          if (error instanceof Error && error.message.includes("mutable or executable context state")) rejected++;
          else throw error;
        }
      }
    } finally {
      for (const [owner, key, descriptor] of replacements.reverse()) Object.defineProperty(owner, key, descriptor);
    }
    expect(result).toEqual({ warm, cold });
    expect(Object.isFrozen(cold)).toBe(true);
    expect(calls).toBe(0);
    expect(rejected).toBe(4);
  });
});

function ledger(imported = false, displaced = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const imports: PhysicalReservation[] = [];
  if (imported) {
    imports.push(tx.reserveFunctionImport("import:f", "test", "f", { params: [], results: [] }));
    imports.push(tx.reserveGlobalImport("import:g", "test", "g", { kind: "i32" }, false));
    imports.push(tx.reserveTag("import:t", { params: [], results: [] }, { kind: "import", module: "test", name: "t" }));
  }
  if (displaced) tx.reserveType("prefix", { kind: "struct", name: "prefix", fields: [] });
  const group = tx.reserveType("group", {
    kind: "rec",
    types: [
      { kind: "struct", name: "a", fields: [] },
      { kind: "struct", name: "b", fields: [] },
    ],
  });
  const fn = tx.reserveFunction("fn", "answer", { params: [], results: [{ kind: "i32" }] });
  const global = tx.reserveGlobal("global", "value", { kind: "f64" }, false);
  const tag = tx.reserveTag("tag", { params: [], results: [] }, { kind: "defined", name: "tag" });
  const table = tx.reserveTable("table", { elementType: "funcref", min: 1 });
  const memory = tx.reserveMemory("memory", { min: 1 });
  const data = tx.reserveDataSegment("data", { offset: 0, bytes: new Uint8Array([42]) });
  const string = tx.reserveString("string", "authentic");
  tx.freezeReservations();
  tx.fillFunction(fn, { locals: [{ name: "unused", type: { kind: "i32" } }], body: [{ op: "i32.const", value: 42 }] });
  tx.fillGlobal(global, [{ op: "f64.const", value: -0 }]);
  return { module, tx, imports, group, fn, global, tag, table, memory, data, string };
}

describe("fresh batch physical-index authentication", () => {
  for (const imported of [false, true])
    for (const displaced of [false, true])
      it(`preserves indices, order and duplicates with imports=${imported}, displaced=${displaced}`, () => {
        const r = ledger(imported, displaced);
        const tokens = [r.string, r.fn, r.group, r.global, r.tag, r.table, r.memory, r.data, ...r.imports, r.fn];
        const expected = tokens.map((token) => r.tx.physicalIndex(token));
        expect(expected.slice(0, 8)).toEqual([0, +imported, +imported + +displaced, +imported, +imported, 0, 0, 0]);
        const indices = r.tx.physicalIndices(tokens);
        expect(indices).toEqual(expected);
        expect(Object.isFrozen(indices)).toBe(true);
        expect(r.tx.physicalIndices([])).toEqual([]);
        r.tx.defineExport("export", "answer", r.fn);
        r.tx.seal();
        expect(r.tx.physicalIndices(tokens)).toEqual(expected);
        if (!imported) {
          const compiled = new WebAssembly.Module(emitBinary(r.module));
          expect(WebAssembly.Module.imports(compiled)).toHaveLength(0);
          expect((new WebAssembly.Instance(compiled).exports.answer as () => number)()).toBe(42);
        }
      });

  it.each(["copied", "foreign"])("refuses %s tokens even after a successful batch", (kind) => {
    const r = ledger(),
      other = ledger();
    expect(r.tx.physicalIndices([r.fn])).toEqual([0]);
    expect(() => r.tx.physicalIndices([r.fn, kind === "copied" ? { ...r.fn } : other.fn])).toThrow("foreign or forged");
    expect(r.tx.state).toBe("failed");
  });

  it("refuses reserving and failed phases even for empty batches", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    expect(() => tx.physicalIndices([])).toThrow("physical index requested in reserving");
    expect(() => tx.physicalIndices([])).toThrow("physical index requested in failed");
  });

  it.each(["object", "hole", "getter"])("refuses a %s input without invoking entry accessors", (kind) => {
    const r = ledger();
    let calls = 0;
    const tokens = kind === "object" ? { length: 1, 0: r.fn } : kind === "hole" ? new Array(1) : [r.fn];
    if (kind === "getter")
      Object.defineProperty(tokens, "0", {
        get() {
          calls++;
          return r.fn;
        },
      });
    expect(() => r.tx.physicalIndices(tokens as PhysicalReservation[])).toThrow(/dense own-data/);
    expect(calls).toBe(0);
  });

  it("never calls a supplied iterator or public imports.filter after auditing", () => {
    const r = ledger(true);
    let calls = 0;
    const tokens = [r.fn, r.global, r.fn];
    Object.defineProperty(tokens, Symbol.iterator, {
      get() {
        calls++;
        throw Error("iterator called");
      },
    });
    r.module.imports.filter = () => {
      calls++;
      r.fn.object.body.length = 0;
      throw Error("filter called");
    };
    expect(r.tx.physicalIndices(tokens)).toEqual([1, 1, 1]);
    expect(calls).toBe(0);
    expect(r.fn.object.body).toHaveLength(1);
  });

  it("audits once per batch and never rereads the public ordinal after that audit", () => {
    const r = ledger();
    let reads = 0;
    Object.defineProperty(r.module.funcOrdinalToPosition, "0", {
      configurable: true,
      get() {
        reads++;
        if (reads % 2 === 0) r.fn.object.body.length = 0;
        return 0;
      },
    });
    expect(r.tx.physicalIndices(Array.from({ length: 17 }, () => r.fn))).toEqual(Array(17).fill(0));
    expect(reads).toBe(1);
    expect(r.fn.object.body).toHaveLength(1);
    // The next call must perform a fresh audit, whose getter mutation is detected.
    expect(() => r.tx.physicalIndices([])).toThrow("altered completed function fn");
    expect(reads).toBe(2);
  });

  it("audits input reflection-trap mutations before computing any coordinates", () => {
    const r = ledger();
    let traps = 0;
    const tokens = new Proxy([r.fn], {
      getOwnPropertyDescriptor(target, key) {
        if (key === "0") {
          traps++;
          r.fn.object.body.length = 0;
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(() => r.tx.physicalIndices(tokens)).toThrow("altered completed function fn");
    expect(traps).toBe(1);
  });

  it.each(["body", "locals", "initializer", "type", "ordinal", "population", "undefined", "hole", "nan-bits"])(
    "refuses %s mutation on an unrelated resource after a previous successful batch",
    (change) => {
      const r = ledger();
      if (change === "nan-bits") {
        const view = new DataView(new ArrayBuffer(8));
        view.setBigUint64(0, 0x7ff8000000000001n, true);
        // A separate genuine completed owner retains the original NaN payload.
        const module = createEmptyModule(),
          tx = new PhysicalModuleReservations(module);
        const fn = tx.reserveFunction("nan", "nan", { params: [], results: [{ kind: "f64" }] });
        tx.freezeReservations();
        tx.fillFunction(fn, { locals: [], body: [{ op: "f64.const", value: view.getFloat64(0, true) }] });
        expect(tx.physicalIndices([fn])).toEqual([0]);
        view.setBigUint64(0, 0x7ff8000000000002n, true);
        Object.assign(fn.object.body[0]!, { value: view.getFloat64(0, true) });
        expect(() => tx.physicalIndices([])).toThrow("altered completed function nan");
        return;
      }
      expect(r.tx.physicalIndices([r.table])).toEqual([0]);
      switch (change) {
        case "body":
          Object.assign(r.fn.object.body[0]!, { value: 43 });
          break;
        case "locals":
          r.fn.object.locals = [...r.fn.object.locals];
          break;
        case "initializer":
          Object.assign(r.global.object.init[0]!, { value: 0 });
          break;
        case "type":
          Object.assign(r.group.object, { name: "changed" });
          break;
        case "ordinal":
          r.module.funcOrdinalToPosition[0] = 1;
          break;
        case "population":
          r.module.functions.push({ ...r.fn.object });
          break;
        case "undefined":
          Object.assign(r.fn.object.body[0]!, { additional: undefined });
          break;
        case "hole":
          Reflect.deleteProperty(r.fn.object.locals, "0");
          break;
      }
      expect(() => r.tx.physicalIndices([])).toThrow(/altered|population/);
      expect(r.tx.state).toBe("failed");
    },
  );
});
