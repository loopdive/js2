// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  EXOTIC_TEXTS,
  stringExoticFixture,
  stringExoticRuntime,
  completeStringExoticFixture,
  fillStringExoticDependencies,
  type StringExoticRuntime,
} from "./helpers/native-string-exotic-fixture.js";
import {
  declareNativeStringOwnDescriptorResources,
  reserveNativeStringOwnDescriptorResources,
  requireNativeStringOwnDescriptorReservations,
  requireCompletedNativeStringOwnDescriptors,
  fillNativeStringOwnDescriptorResources,
} from "../src/backend/wasmgc/resources/native-string-exotic-own-descriptors.js";
import { buildStringExoticIndexDefinition } from "../src/runtime/wasmgc/values/string-exotic-bodies.js";

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
const indexCases: readonly [string, bigint][] = [
  ["0", 0n],
  ["1", 1n],
  ["9", 9n],
  ["10", 10n],
  ["2147483647", 2147483647n],
  ["2147483648", 2147483648n],
  ["4294967294", 4294967294n],
  ...[
    "4294967295",
    "9007199254740991",
    "99999999999",
    "00",
    "01",
    "-0",
    "-1",
    "1.0",
    "1e0",
    "NaN",
    "Infinity",
    "",
    " ",
    "１",
    "1\0",
  ].map((key): [string, bigint] => [key, -1n]),
];
function key(e: StringExoticRuntime, text: string): object {
  const index = EXOTIC_TEXTS.indexOf(text);
  if (index < 0) throw Error("unreserved real key " + text);
  return e.text(index);
}
function character(e: StringExoticRuntime, value: unknown): string {
  expect(e.length(value)).toBe(1);
  return String.fromCharCode(e.codeUnit(value, 0));
}
for (const utf8 of [false, true])
  for (const shifted of [false, true]) {
    describe(`native String virtual descriptors utf8=${utf8} shifted=${shifted}`, () => {
      let e: StringExoticRuntime;
      beforeAll(() => {
        e = stringExoticRuntime(utf8, shifted).runtime;
      });
      it.each(indexCases)("parses full-range canonical key %j → %s", (text, expected) => {
        expect(e.arrayIndex(key(e, text))).toBe(expected);
      });
      it("rejects Symbols and arbitrary foreign values without coercion", () => {
        const foreign = {
          toString() {
            throw Error("must not coerce");
          },
        };
        expect(e.arrayIndex(e.symbol())).toBe(-1n);
        for (const value of [foreign, 0, "0", null, undefined]) expect(e.arrayIndex(value)).toBe(-1n);
      });
      it.each(["", "a", "😀", "é😀\ud800\0", "0123456789"])(
        "matches native String character descriptors for %j",
        (text) => {
          const payload = key(e, text),
            object = e.make(e.createRoot(), payload),
            oracle = Object(text);
          expect(e.payload(object)).toBe(payload);
          expect(e.count(object)).toBe(0);
          for (let i = 0; i <= text.length; i++) {
            const own = e.own(object, key(e, String(i))),
              descriptor = Object.getOwnPropertyDescriptor(oracle, String(i));
            if (!descriptor) expect(own[0]).toBe(-1);
            else {
              expect(own[0]).toBe(
                (descriptor.writable ? 1 : 0) | (descriptor.enumerable ? 2 : 0) | (descriptor.configurable ? 4 : 0),
              );
              expect(character(e, own[1])).toBe(descriptor.value);
            }
          }
          expect(e.payload(object)).toBe(payload);
          expect(e.count(object)).toBe(0); // virtual descriptors never become mutable table entries
        },
      );
      it("reads original UTF16 slice offsets and retains the exact StringData carrier", () => {
        const payload = e.slice(),
          object = e.make(e.createRoot(), payload),
          expected = "é😀\ud800\0";
        for (let i = 0; i < expected.length; i++)
          expect(character(e, e.own(object, key(e, String(i)))[1])).toBe(expected[i]);
        expect(e.own(object, key(e, "5"))[0]).toBe(-1);
        expect(e.payload(object)).toBe(payload);
      });
      it("flattens mixed native ropes without replacing StringData or losing surrogate halves", () => {
        const payload = e.rope(key(e, "a"), key(e, "😀")),
          object = e.make(e.createRoot(), payload);
        for (let run = 0; run < 2; run++)
          for (let i = 0; i < 3; i++) {
            expect(character(e, e.own(object, key(e, String(i)))[1])).toBe("a😀"[i]);
            expect(e.payload(object)).toBe(payload);
          }
      });
      it("keeps noncanonical/out-of-range/length keys ordinary and uses the exact String subtype", () => {
        const root = e.createRoot(),
          object = e.make(root, key(e, "a"));
        for (const text of ["01", "-0", "1.0", "1e0", "-1", "1", "length"])
          expect(e.own(object, key(e, text))[0]).toBe(-1);
        expect(e.own(e.boolean(root), key(e, "0"))[0]).toBe(-1);
        expect(e.own(root, key(e, "0"))[0]).toBe(-1);
        e.put(object, key(e, "01"), 42, 7, 0);
        expect(e.own(object, key(e, "01"))).toEqual([7, 42]);
        expect(e.count(object)).toBe(1);
      });
      it("returns an actual ordinary descriptor first on a controlled prepopulated carrier", () => {
        const object = e.make(e.createRoot(), key(e, "a"));
        e.put(object, key(e, "0"), 42, 7, 0);
        expect(e.own(object, key(e, "0"))).toEqual([7, 42]);
        // This checks GetOwnProperty order; raw insert is not a legal public String Define grant.
      });
      it("finds virtual descriptors at every ancestor cursor through ordinary receivers", () => {
        const string = e.make(e.createRoot(), key(e, "😀"));
        const child = e.createWithPrototype(string),
          grandchild = e.createWithPrototype(child);
        expect(e.own(grandchild, key(e, "0"))[0]).toBe(-1);
        for (const object of [child, grandchild])
          for (let i = 0; i < 2; i++) {
            const descriptor = e.inherited(object, key(e, String(i)));
            expect(descriptor[0]).toBe(2);
            expect(character(e, descriptor[1])).toBe("😀"[i]);
          }
        expect(e.inherited(grandchild, key(e, "2"))[0]).toBe(-1);
      });
    });
  }
describe("authentic String exotic own-descriptor owner", () => {
  it("reserves exactly three non-exported functions and completes only real filled prerequisites", () => {
    const f = stringExoticFixture();
    expect(f.module.exports).toEqual([]);
    expect(f.pack.completionScope).toBe("string-exotic-own-descriptors");
    expect(() => requireCompletedNativeStringOwnDescriptors(f.tx, f.pack, f.dependencies)).toThrow(
      "missing canonical fill",
    );
    f.tx.freezeReservations();
    expect(() => fillNativeStringOwnDescriptorResources(f.tx, f.pack)).toThrow("missing canonical fill");
    fillStringExoticDependencies(f);
    fillNativeStringOwnDescriptorResources(f.tx, f.pack);
    expect(requireCompletedNativeStringOwnDescriptors(f.tx, f.pack, f.dependencies)).toBe(f.pack);
    expect(() => fillNativeStringOwnDescriptorResources(f.tx, f.pack)).toThrow("duplicate fill");
  });
  it.each(["layouts", "layoutDependencies", "lookup", "lookupDependencies"] as const)(
    "rejects copied %s before any allocation",
    (role) => {
      const f = stringExoticFixture(),
        before = structuredClone(f.module);
      const copied = { ...f.dependencies, [role]: { ...f.dependencies[role] } };
      const plan = declareNativeStringOwnDescriptorResources("bad", {
        object: f.objects.object.key,
        propEntry: f.objects.propEntry.key,
      });
      expect(() => reserveNativeStringOwnDescriptorResources(f.tx, "bad", plan, copied)).toThrow();
      expect(f.module).toStrictEqual(before);
    },
  );
  it("rejects copied, foreign and replaced expected owners", () => {
    const f = stringExoticFixture(),
      other = stringExoticFixture();
    expect(requireNativeStringOwnDescriptorReservations(f.tx, f.pack, f.dependencies)).toBe(f.pack);
    expect(() => requireNativeStringOwnDescriptorReservations(f.tx, { ...f.pack }, f.dependencies)).toThrow("unissued");
    expect(() => requireNativeStringOwnDescriptorReservations(other.tx, f.pack, f.dependencies)).toThrow("foreign");
    expect(() => requireNativeStringOwnDescriptorReservations(f.tx, f.pack, { ...f.dependencies })).toThrow(
      "foreign expected",
    );
  });
  it("rejects declaration, dependency and post-completion body mutation", () => {
    const changedPlan = stringExoticFixture(false, false, true);
    const declaration = changedPlan.plan.declarations[0]!;
    if (declaration.space !== "function") throw Error("wrong fixture declaration");
    (declaration as { name: string }).name = "retargeted";
    expect(() =>
      requireNativeStringOwnDescriptorReservations(changedPlan.tx, changedPlan.pack, changedPlan.dependencies),
    ).toThrow("changed declaration");
    const d = stringExoticFixture();
    Object.assign(d.dependencies, { lookup: { ...d.lookup } });
    expect(() => requireNativeStringOwnDescriptorReservations(d.tx, d.pack, d.dependencies)).toThrow(
      "substituted dependency",
    );
    const f = completeStringExoticFixture();
    f.pack.virtualOwn.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeStringOwnDescriptors(f.tx, f.pack, f.dependencies)).toThrow("altered completed");
  });
  it("rejects non-data dependencies without invoking accessors", () => {
    const f = stringExoticFixture(),
      before = structuredClone(f.module);
    let calls = 0;
    const d = { ...f.dependencies };
    Object.defineProperty(d, "lookup", {
      get() {
        calls++;
        return f.lookup;
      },
    });
    expect(() => reserveNativeStringOwnDescriptorResources(f.tx, "bad", f.plan, d)).toThrow("non-data");
    expect(calls).toBe(0);
    expect(f.module).toStrictEqual(before);
  });
  it.each([undefined, -1, 1.5, NaN, Infinity, 0x100000000])("rejects malformed pure-body coordinates %s", (value) => {
    expect(() =>
      buildStringExoticIndexDefinition({
        anyStrTypeIdx: 1,
        nativeStrTypeIdx: 2,
        nativeStrDataTypeIdx: 3,
        flattenIdx: value as number,
      }),
    ).toThrow("invalid binding");
  });
});
