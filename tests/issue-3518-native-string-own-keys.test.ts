// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CREATE_TEXTS } from "./helpers/native-string-create-fixture.js";
import { EXOTIC_TEXTS } from "./helpers/native-string-exotic-fixture.js";
import { completeStringDefineFixturePhases } from "./helpers/native-string-define-fixture.js";
import {
  stringKeysFixture,
  stringKeysRuntimePhases,
  type StringKeysRuntime,
} from "./helpers/native-string-own-keys-fixture.js";
import {
  declareNativeStringOwnKeysResources,
  reserveNativeStringOwnKeysResources,
  requireNativeStringOwnKeysReservations,
  fillNativeStringOwnKeysResources,
  requireCompletedNativeStringOwnKeys,
} from "../src/backend/wasmgc/resources/native-string-own-keys.js";

function phasedFixture<T>(factory: () => Generator<string, T>, count: number, ready: (result: T) => void) {
  let phases: Generator<string, T>;
  beforeAll(() => {
    phases = factory();
  }, 35000);
  for (let index = 0; index < count; index++)
    beforeAll(async () => {
      const start = performance.now(),
        step = phases.next();
      expect(step.done, "fixture phase " + index).toBe(false);
      expect(typeof step.value).toBe("string");
      console.info("native key fixture phase", index, step.value, Math.round(performance.now() - start));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }, 35000);
  beforeAll(() => {
    const step = phases.next();
    expect(step.done, "all fixture phases completed").toBe(true);
    ready(step.value as T);
  }, 35000);
}

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
const key = (e: StringKeysRuntime, text: string): object => {
  const index = EXOTIC_TEXTS.indexOf(text);
  if (index < 0) throw Error("unreserved key " + text);
  return e.key(index);
};
function text(e: StringKeysRuntime, value: object): string {
  return Array.from({ length: e.textLength(value) }, (_, i) => String.fromCharCode(e.codeUnit(value, i))).join("");
}
function rows(e: StringKeysRuntime, object: object, symbols: object[] = []): (string | number)[] {
  const list = e.ownKeys(object);
  return Array.from({ length: e.listLength(list) }, (_, i) => {
    const value = e.listAt(list, i);
    if (!e.isSymbol(value)) return text(e, value);
    const ordinal = symbols.findIndex((s) => Object.is(s, value));
    expect(ordinal).toBeGreaterThanOrEqual(0);
    return ordinal;
  });
}
function snapshot(e: StringKeysRuntime, o: object) {
  return [e.prototype(o), e.payload(o), e.table(o), e.count(o), e.tombstones(o), e.flags(o), e.nextSeq(o)];
}
for (const utf8 of [false, true])
  for (const shifted of [false, true]) {
    describe(`native String own keys utf8=${utf8} shifted=${shifted}`, () => {
      let e: StringKeysRuntime;
      phasedFixture(
        () => stringKeysRuntimePhases(utf8, shifted),
        23,
        (result) => {
          e = result.runtime;
          expect(e.isUtf8(e.text(1))).toBe(Number(utf8));
        },
      );
      it.each([...CREATE_TEXTS.map((_, index) => index), "offset" as const])(
        "matches all virtual keys and length for payload %s",
        (index) => {
          const payload = index === "offset" ? e.slice() : e.text(index),
            o = e.make(null, payload),
            before = snapshot(e, o);
          const expected = Reflect.ownKeys(Object(text(e, payload)));
          expect(rows(e, o)).toEqual(expected);
          expect(snapshot(e, o)).toEqual(before);
          const a = e.ownKeys(o),
            b = e.ownKeys(o);
          expect(Object.is(a, b)).toBe(false);
          expect(e.listLength(a)).toBe(e.textLength(payload) + 1);
        },
      );
      it.each([0, 1, 9, 10, 99, 100, 2147483647, 2147483648, 4294967294, 4294967295])(
        "formats unsigned index %i exactly",
        (value) => {
          expect(text(e, e.indexKey(value))).toBe(String(value));
        },
      );
      it("orders every canonical boundary before noncanonical strings and preserves metadata", () => {
        const o = e.make(e.root(), e.text(1)),
          native = Object("a"),
          beforeProto = e.prototype(o);
        const keys = [
          "own",
          "4294967295",
          "2147483648",
          "4294967294",
          "2147483647",
          "10",
          "1",
          "00",
          "-0",
          "1.0",
          "1e0",
          "NaN",
          "9007199254740991",
        ];
        for (const k of keys) {
          e.defineData(o, key(e, k), e.freshChar(97), 191);
          Object.defineProperty(native, k, { value: "a", writable: true, enumerable: true, configurable: true });
        }
        const before = snapshot(e, o);
        expect(rows(e, o)).toEqual(Reflect.ownKeys(native));
        expect(snapshot(e, o)).toEqual(before);
        expect(e.prototype(o)).toBe(beforeProto);
      });
      it("lists nonenumerable and accessor properties without invoking them", () => {
        const o = e.make(null, e.text(1));
        e.defineData(o, key(e, "own"), e.freshChar(97), 128);
        const beforeCalls = e.getterCalls();
        expect(e.invokeObservedGetter()).toBe(7);
        expect(e.getterCalls()).toBe(beforeCalls + 1);
        e.defineAccessor(o, key(e, "00"), e.observedClosure(), e.undefinedValue(), 256);
        const before = snapshot(e, o);
        expect(rows(e, o)).toEqual(["0", "length", "own", "00"]);
        expect(e.getterCalls()).toBe(beforeCalls + 1);
        expect(snapshot(e, o)).toEqual(before);
      });
      it("keeps interleaved distinct symbols after all strings in creation order", () => {
        const o = e.make(null, e.text(1)),
          a = e.symbol(1),
          b = e.symbol(2);
        e.defineData(o, b, e.freshChar(97), 191);
        e.defineData(o, key(e, "own"), e.freshChar(97), 191);
        e.defineData(o, a, e.freshChar(97), 191);
        e.defineData(o, key(e, "2"), e.freshChar(97), 191);
        const native = Object("a"),
          sa = Symbol(),
          sb = Symbol();
        for (const k of [sb, "own", sa, "2"]) Object.defineProperty(native, k, { value: 1, configurable: true });
        const expected = Reflect.ownKeys(native).map((k) => (typeof k === "symbol" ? [sa, sb].indexOf(k) : k));
        const before = snapshot(e, o);
        expect(rows(e, o, [a, b])).toEqual(expected);
        expect(snapshot(e, o)).toEqual(before);
      });
      it("excludes tombstones and preserves delete/reinsert chronology", () => {
        const o = e.make(null, e.text(1)),
          native = Object("a");
        for (const k of ["own", "00"]) {
          e.defineData(o, key(e, k), e.freshChar(97), 191);
          Object.defineProperty(native, k, { value: 1, configurable: true });
        }
        e.markDeleted(o, key(e, "own"));
        Reflect.deleteProperty(native, "own");
        const deleted = snapshot(e, o);
        expect(rows(e, o)).toEqual(Reflect.ownKeys(native));
        expect(snapshot(e, o)).toEqual(deleted);
        e.defineData(o, key(e, "own"), e.freshChar(98), 191);
        Object.defineProperty(native, "own", { value: 2, configurable: true });
        expect(rows(e, o)).toEqual(Reflect.ownKeys(native));
      });
      it("suppresses a deliberate ordinary shadow of a virtual index", () => {
        const o = e.make(null, e.text(1));
        e.put(o, key(e, "0"), 42);
        const before = snapshot(e, o);
        expect(e.ownValue(o, key(e, "0"))).toBe(42);
        expect(rows(e, o)).toEqual(["0", "length"]);
        expect(snapshot(e, o)).toEqual(before);
      });
      it("compares the full unsigned creation sequence domain", () => {
        const o = e.make(null, e.text(1));
        for (const k of ["own", "00"]) e.defineData(o, key(e, k), e.freshChar(97), 191);
        e.setSeq(o, key(e, "own"), 2147483647);
        e.setSeq(o, key(e, "00"), 2147483648);
        expect(rows(e, o)).toEqual(["0", "length", "own", "00"]);
      });
      it("refuses impossible list cardinality without changing the source object", () => {
        const o = e.make(null, e.header(-1)),
          before = snapshot(e, o);
        expect(() => e.ownKeys(o)).toThrow(WebAssembly.RuntimeError);
        expect(snapshot(e, o)).toEqual(before);
      });
    });
  }
describe("authenticated native String key-list owner", () => {
  describe("independent completion lifecycle", () => {
    let completed: ReturnType<typeof stringKeysFixture>;
    phasedFixture(
      function* () {
        const f = stringKeysFixture();
        expect(() => requireCompletedNativeStringOwnKeys(f.tx, f.keys, f.keyDependencies)).toThrow(
          "missing canonical fill",
        );
        f.tx.freezeReservations();
        expect(() => fillNativeStringOwnKeysResources(f.tx, f.keys)).toThrow();
        for (const fn of [f.keys.ownKeys, f.keys.indexKey, f.keys.entryBefore]) expect(fn.object.body).toEqual([]);
        yield "refused missing dependencies without filling";
        const ready = yield* completeStringDefineFixturePhases(stringKeysFixture());
        fillNativeStringOwnKeysResources(ready.tx, ready.keys);
        yield "completed String key-list bodies";
        return ready;
      },
      20,
      (result) => {
        completed = result;
      },
    );
    it("requires actual dependency and own-body completion", () => {
      expect(requireCompletedNativeStringOwnKeys(completed.tx, completed.keys, completed.keyDependencies)).toBe(
        completed.keys,
      );
      expect(completed.keys.completionScope).toBe("string-own-key-list");
    });
  });
  it.each(["copiedPack", "copiedDependencies", "unknown", "getter"])(
    "refuses %s dependencies before allocation",
    (kind) => {
      const f = stringKeysFixture(),
        before = structuredClone(f.module);
      const d = { ...f.keyDependencies };
      let calls = 0;
      if (kind === "copiedPack") d.own = { ...d.own };
      if (kind === "copiedDependencies") d.ownDependencies = { ...d.ownDependencies };
      if (kind === "unknown") Object.assign(d, { arbitrary: true });
      if (kind === "getter")
        Object.defineProperty(d, "own", {
          get() {
            calls++;
            return f.pack;
          },
        });
      const plan = declareNativeStringOwnKeysResources("bad", {
        stringObject: f.layouts.types.String.key,
        propEntry: f.objects.propEntry.key,
      });
      expect(() => reserveNativeStringOwnKeysResources(f.tx, "bad", plan, d)).toThrow();
      expect(calls).toBe(0);
      expect(f.module).toStrictEqual(before);
    },
  );
  it("rejects copied/foreign owners, expected dependencies and source mutations", () => {
    const f = stringKeysFixture(false, false, true),
      other = stringKeysFixture();
    expect(() => requireNativeStringOwnKeysReservations(f.tx, { ...f.keys }, f.keyDependencies)).toThrow("copied");
    expect(() => requireNativeStringOwnKeysReservations(other.tx, f.keys, f.keyDependencies)).toThrow("foreign");
    expect(() => requireNativeStringOwnKeysReservations(f.tx, f.keys, { ...f.keyDependencies })).toThrow("expected");
    Object.assign(f.keyPlan.declarations[0]!, { key: "swapped" });
    expect(() => requireNativeStringOwnKeysReservations(f.tx, f.keys, f.keyDependencies)).toThrow();
  });
  describe("producer and filled-body integrity", () => {
    let f: ReturnType<typeof stringKeysFixture>;
    phasedFixture(
      function* () {
        f = stringKeysFixture();
        const original = f.keyDependencies.own;
        f.keyDependencies.own = { ...f.pack };
        expect(() => requireNativeStringOwnKeysReservations(f.tx, f.keys, f.keyDependencies)).toThrow("substituted");
        f.keyDependencies.own = original;
        yield "refused mutable producer substitution";
        yield* completeStringDefineFixturePhases(f);
        fillNativeStringOwnKeysResources(f.tx, f.keys);
        yield "completed String key-list bodies";
        return f;
      },
      20,
      (result) => {
        f = result;
      },
    );
    it("rejects mutable producer substitution and post-completion changes", () => {
      f.keys.ownKeys.object.body.push({ op: "nop" });
      expect(() => requireCompletedNativeStringOwnKeys(f.tx, f.keys, f.keyDependencies)).toThrow("altered completed");
    });
  });
});

describe("native String key-list declaration data boundary", () => {
  it("accepts equivalent canonical and null-prototype records", () => {
    const types = { stringObject: "String", propEntry: "PropEntry" };
    expect(declareNativeStringOwnKeysResources("test", Object.assign(Object.create(null), types))).toStrictEqual(
      declareNativeStringOwnKeysResources("test", types),
    );
  });
  it.each([
    "null",
    "array",
    "missing",
    "inherited",
    "unknown",
    "symbol",
    "empty",
    "objectNumber",
    "entryNumber",
    "duplicate",
    "objectGetter",
    "entryGetter",
  ])("refuses %s types without invoking getters", (kind) => {
    let calls = 0;
    let input: unknown = { stringObject: "String", propEntry: "PropEntry" };
    if (kind === "null") input = null;
    if (kind === "array") input = [];
    if (kind === "missing") input = {};
    if (kind === "inherited") input = Object.create(input as object);
    if (kind === "unknown") Object.assign(input!, { unexpected: "value" });
    if (kind === "symbol") Object.assign(input!, { [Symbol("unknown")]: "value" });
    if (kind === "empty") Object.assign(input!, { stringObject: "" });
    if (kind === "objectNumber") Object.assign(input!, { stringObject: 1 });
    if (kind === "entryNumber") Object.assign(input!, { propEntry: 2 });
    if (kind === "duplicate") Object.assign(input!, { propEntry: "String" });
    if (kind === "objectGetter" || kind === "entryGetter")
      Object.defineProperty(input as object, kind === "objectGetter" ? "stringObject" : "propEntry", {
        get() {
          calls++;
          return "String";
        },
      });
    expect(() =>
      declareNativeStringOwnKeysResources("test", input as Parameters<typeof declareNativeStringOwnKeysResources>[1]),
    ).toThrow();
    expect(calls).toBe(0);
  });
});
