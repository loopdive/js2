// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EXOTIC_TEXTS } from "./helpers/native-string-exotic-fixture.js";
import {
  stringDefineFixture,
  completeStringDefineFixturePhases,
  stringDefineRuntimePhases,
  type StringDefineFixture,
  type StringDefineRuntime,
} from "./helpers/native-string-define-fixture.js";
import {
  declareNativeObjectDescriptorResources,
  reserveNativeObjectDescriptorResources,
  requireNativeObjectDescriptorReservations,
  requireCompletedNativeObjectDescriptors,
  requireCompletedNativeStringDefinitions,
  nativeObjectDescriptorReservationInventory,
} from "../src/backend/wasmgc/resources/native-object-descriptors.js";

/** Fresh real lifecycle per group; each measured phase retains the repository35s limit. */
function phasedFixture<T>(factory: () => Generator<string, T>, count: number, ready: (result: T) => void) {
  let phases: Generator<string, T>;
  beforeAll(() => {
    phases = factory();
  });
  for (let index = 0; index < count; index++)
    beforeAll(async () => {
      const step = phases.next();
      expect(step.done, "fixture phase " + index).toBe(false);
      expect(typeof step.value).toBe("string");
      console.info("native fixture phase", index, step.value);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }, 35000);
  beforeAll(() => {
    const step = phases.next();
    expect(step.done, "all fixture phases completed").toBe(true);
    ready(step.value as T);
  }, 35000);
}

afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
const key = (e: StringDefineRuntime, text: string) => {
  const index = EXOTIC_TEXTS.indexOf(text);
  if (index < 0) throw Error("unreserved key " + text);
  return e.key(index);
};
function result(e: StringDefineRuntime, action: () => void): boolean {
  try {
    action();
    return true;
  } catch (error) {
    if (!(error instanceof WebAssembly.Exception) || !error.is(e.exception)) throw error;
    const payload = error.getArg(e.exception, 0) as object;
    expect(e.errorTag(payload)).toBe(-11);
    expect(e.codeUnit(e.errorName(payload), 0)).toBe("T".charCodeAt(0));
    expect(e.codeUnit(e.errorMessage(payload), 0)).toBeGreaterThan(0);
    return false;
  }
}
const presence = [undefined, false, true] as const;
const cases = presence.flatMap((writable) =>
  presence.flatMap((enumerable) =>
    presence.flatMap((configurable) =>
      ["absent", "same", "different", "undefined"].map((value) => ({ writable, enumerable, configurable, value })),
    ),
  ),
);
function descriptor(row: (typeof cases)[number]): PropertyDescriptor {
  const d: PropertyDescriptor = {};
  for (const name of ["writable", "enumerable", "configurable"] as const)
    if (row[name] !== undefined) d[name] = row[name];
  if (row.value !== "absent") d.value = row.value === "same" ? "a" : row.value === "different" ? "b" : undefined;
  return d;
}
function mask(d: PropertyDescriptor): number {
  let bits = 0;
  for (const [name, present, value] of [
    ["writable", 8, 1],
    ["enumerable", 16, 2],
    ["configurable", 32, 4],
  ] as const)
    if (Object.hasOwn(d, name)) bits |= present | (d[name] ? value : 0);
  return bits | (Object.hasOwn(d, "value") ? 128 : 0);
}
function unchanged(e: StringDefineRuntime, o: object, table: object, payload: object, state: number[]): void {
  expect(Object.is(e.table(o), table)).toBe(true);
  expect(Object.is(e.payload(o), payload)).toBe(true);
  expect([e.count(o), e.tombstones(o), e.nextSeq(o), e.flags(o)]).toEqual(state);
}
for (const utf8 of [false, true])
  for (const shifted of [false, true]) {
    describe(`genuine native String definition utf8=${utf8} shifted=${shifted}`, () => {
      let e: StringDefineRuntime;
      phasedFixture(
        () => stringDefineRuntimePhases(utf8, shifted),
        20,
        (result) => {
          e = result.runtime;
        },
      );
      it.each(cases)("matches all virtual descriptor fields %j", (row) => {
        const payload = e.text(1),
          o = e.make(null, payload),
          table = e.table(o),
          d = descriptor(row);
        expect(e.isUtf8(payload)).toBe(Number(utf8));
        const expected = Reflect.defineProperty(Object("a"), "0", d);
        const value =
          row.value === "same" ? e.freshChar(97) : row.value === "different" ? e.freshChar(98) : e.undefinedValue();
        expect(result(e, () => e.defineData(o, key(e, "0"), value, mask(d)))).toBe(expected);
        unchanged(e, o, table, payload, [1, 0, 1, 128]);
        expect(e.ordinaryHas(o, key(e, "0"))).toBe(0);
        expect(e.codeUnit(e.ownValue(o, key(e, "0")), 0)).toBe(97);
      });
      it("accepts compatible virtual descriptors on a nonextensible String", () => {
        const p = e.text(1),
          o = e.make(null, p),
          table = e.table(o);
        e.setFlags(o, 129);
        for (const bits of [0, 8, 18, 32, 58, 128, 186]) {
          expect(result(e, () => e.defineData(o, key(e, "0"), e.freshChar(97), bits))).toBe(true);
          unchanged(e, o, table, p, [1, 0, 1, 129]);
        }
        expect(result(e, () => e.defineData(o, key(e, "own"), e.freshChar(97), 128))).toBe(false);
        unchanged(e, o, table, p, [1, 0, 1, 129]);
      });
      it("retains both surrogate halves and independently allocated SameValue characters", () => {
        const p = e.text(2),
          o = e.make(null, p),
          table = e.table(o);
        for (const [index, unit] of [
          [0, 0xd83d],
          [1, 0xde00],
        ] as const) {
          const a = e.ownValue(o, key(e, String(index))),
            b = e.freshChar(unit);
          expect(Object.is(a, b)).toBe(false);
          expect(e.sameValue(a, b)).toBe(1);
          expect(result(e, () => e.defineData(o, key(e, String(index)), b, 128))).toBe(true);
          expect(result(e, () => e.defineData(o, key(e, String(index)), e.freshChar(unit ^ 1), 128))).toBe(false);
        }
        unchanged(e, o, table, p, [1, 0, 1, 128]);
      });
      it("routes attributes-only definitions through virtual compatibility", () => {
        const p = e.text(1),
          o = e.make(null, p),
          table = e.table(o);
        for (const enumerable of presence)
          for (const configurable of presence) {
            const d: PropertyDescriptor = {};
            if (enumerable !== undefined) d.enumerable = enumerable;
            if (configurable !== undefined) d.configurable = configurable;
            expect(result(e, () => e.defineAttributes(o, key(e, "0"), mask(d)))).toBe(
              Reflect.defineProperty(Object("a"), "0", d),
            );
            unchanged(e, o, table, p, [1, 0, 1, 128]);
          }
      });
      it("refuses all virtual accessor conversions before any table mutation", () => {
        const p = e.text(1),
          o = e.make(null, p),
          table = e.table(o);
        for (const bits of [256, 512, 768])
          for (const half of [e.undefinedValue(), e.closure()]) {
            expect(result(e, () => e.defineAccessor(o, key(e, "0"), half, half, bits))).toBe(false);
            unchanged(e, o, table, p, [1, 0, 1, 128]);
          }
      });
      it("keeps length ordinary and rejects incompatible values and attributes", () => {
        const p = e.text(1),
          o = e.make(null, p),
          table = e.table(o);
        expect(result(e, () => e.defineAttributes(o, key(e, "length"), 0))).toBe(true);
        for (const bits of [9, 18, 36])
          expect(result(e, () => e.defineData(o, key(e, "length"), e.undefinedValue(), bits))).toBe(false);
        expect(result(e, () => e.defineData(o, key(e, "length"), e.undefinedValue(), 128))).toBe(false);
        unchanged(e, o, table, p, [1, 0, 1, 128]);
        expect(e.lengthValue(o)).toBe(1);
        expect(e.lengthFlags(o)).toBe(0);
      });
      it("preserves ordinary expandos, noncanonical keys and ordinary accessors", () => {
        for (const name of ["own", "01", "-0", "4294967295"]) {
          const o = e.make(null, e.text(1)),
            k = key(e, name),
            v = e.freshChar(98);
          expect(result(e, () => e.defineData(o, k, v, 191))).toBe(true);
          expect(e.ordinaryHas(o, k)).toBe(1);
          expect(e.sameValue(e.ownValue(o, k), v)).toBe(1);
          expect([e.count(o), e.nextSeq(o)]).toEqual([2, 2]);
          expect(e.lengthSeq(o)).toBe(0);
          expect(result(e, () => e.defineAttributes(o, k, 18))).toBe(true);
        }
        const o = e.make(null, e.text(1)),
          k = key(e, "own");
        expect(result(e, () => e.defineAccessor(o, k, e.closure(), e.undefinedValue(), 256 | 32 | 4))).toBe(true);
        expect(e.ordinaryHas(o, k)).toBe(1);
        expect(e.ownFlags(o, k) & 8).toBe(8);
      });
      it("uses virtual-first definition even after a deliberate raw-storage bypass", () => {
        const p = e.text(1),
          o = e.make(null, p),
          k = key(e, "0");
        e.put(o, k, 42);
        const table = e.table(o);
        expect(e.ownValue(o, k)).toBe(42);
        expect(result(e, () => e.defineData(o, k, e.freshChar(98), 128))).toBe(false);
        expect(result(e, () => e.defineData(o, k, e.freshChar(97), 128))).toBe(true);
        expect(e.ownValue(o, k)).toBe(42);
        unchanged(e, o, table, p, [2, 0, 2, 128]);
      });
      it("retains the genuine boundary errors for malformed descriptors", () => {
        const o = e.make(null, e.text(1)),
          p = e.payload(o),
          table = e.table(o);
        for (const bits of [-1, NaN, Infinity, 0.5, 64, 256])
          expect(result(e, () => e.defineData(o, key(e, "0"), e.undefinedValue(), bits))).toBe(false);
        expect(result(e, () => e.defineAccessor(o, key(e, "0"), {}, e.undefinedValue(), 256))).toBe(false);
        unchanged(e, o, table, p, [1, 0, 1, 128]);
      });
    });
  }
describe("authenticated String definition selection", () => {
  describe("selected owner lifecycle", () => {
    let f: StringDefineFixture;
    phasedFixture(
      function* () {
        f = stringDefineFixture();
        expect(
          nativeObjectDescriptorReservationInventory(f.tx, f.descriptors, f.descriptorDependencies).ownDescriptorMode,
        ).toBe("string-exotic");
        expect(() => requireCompletedNativeStringDefinitions(f.tx, f.descriptors, f.descriptorDependencies)).toThrow(
          "missing canonical fill",
        );
        return yield* completeStringDefineFixturePhases(f);
      },
      18,
      (result) => {
        f = result;
      },
    );
    it("grants String completion only after the genuine selected bodies", () => {
      expect(requireCompletedNativeStringDefinitions(f.tx, f.descriptors, f.descriptorDependencies)).toBe(
        f.descriptors,
      );
    });
  });
  describe("ordinary owner lifecycle", () => {
    let f: StringDefineFixture;
    phasedFixture(
      () => completeStringDefineFixturePhases(stringDefineFixture(false, false, false)),
      18,
      (result) => {
        f = result;
      },
    );
    it("cannot infer String completion from a genuinely completed ordinary owner", () => {
      expect(requireCompletedNativeObjectDescriptors(f.tx, f.descriptors, f.descriptorDependencies)).toBe(
        f.descriptors,
      );
      expect(() => requireCompletedNativeStringDefinitions(f.tx, f.descriptors, f.descriptorDependencies)).toThrow(
        "no issued String",
      );
    });
  });
  it.each(["copiedPack", "copiedDependencies", "unknown", "getter"] as const)(
    "refuses %s selection before reserving",
    (kind) => {
      const f = stringDefineFixture(),
        before = structuredClone(f.module);
      const selection = { pack: f.pack, dependencies: f.dependencies };
      let calls = 0;
      if (kind === "copiedPack") selection.pack = { ...f.pack };
      if (kind === "copiedDependencies") selection.dependencies = { ...f.dependencies };
      if (kind === "unknown") Object.assign(selection, { extra: true });
      if (kind === "getter")
        Object.defineProperty(selection, "pack", {
          get() {
            calls++;
            return f.pack;
          },
        });
      expect(() =>
        reserveNativeObjectDescriptorResources(
          f.tx,
          "bad",
          { ...f.descriptorDependencies, stringOwn: selection },
          declareNativeObjectDescriptorResources("bad"),
        ),
      ).toThrow();
      expect(calls).toBe(0);
      expect(f.module).toStrictEqual(before);
    },
  );
  it("refuses a foreign issued String owner before any allocation", () => {
    const f = stringDefineFixture(),
      other = stringDefineFixture(),
      before = structuredClone(f.module);
    expect(() =>
      reserveNativeObjectDescriptorResources(
        f.tx,
        "bad",
        { ...f.descriptorDependencies, stringOwn: { pack: other.pack, dependencies: other.dependencies } },
        declareNativeObjectDescriptorResources("bad"),
      ),
    ).toThrow("foreign");
    expect(f.module).toStrictEqual(before);
  });
  describe("post-fill integrity", () => {
    let c: StringDefineFixture;
    phasedFixture(
      () => completeStringDefineFixturePhases(),
      18,
      (result) => {
        c = result;
      },
    );
    it("rejects nested substitution, late selection and post-fill body mutation", () => {
      const a = stringDefineFixture();
      Object.assign(a.descriptorDependencies.stringOwn!, { pack: { ...a.pack } });
      expect(() => requireNativeObjectDescriptorReservations(a.tx, a.descriptors, a.descriptorDependencies)).toThrow();
      const b = stringDefineFixture(false, false, false);
      Object.assign(b.descriptorDependencies, { stringOwn: { pack: b.pack, dependencies: b.dependencies } });
      expect(() => requireNativeObjectDescriptorReservations(b.tx, b.descriptors, b.descriptorDependencies)).toThrow(
        "changed issued selection",
      );
      c.descriptors.defineData.object.body.push({ op: "nop" });
      expect(() => requireCompletedNativeStringDefinitions(c.tx, c.descriptors, c.descriptorDependencies)).toThrow(
        "altered completed",
      );
    });
  });
  it("refuses replacing a selected field with a getter without invoking it", () => {
    const f = stringDefineFixture();
    let calls = 0;
    Object.defineProperty(f.descriptorDependencies, "stringOwn", {
      get() {
        calls++;
        return { pack: f.pack, dependencies: f.dependencies };
      },
    });
    expect(() => requireNativeObjectDescriptorReservations(f.tx, f.descriptors, f.descriptorDependencies)).toThrow(
      "non-data",
    );
    expect(calls).toBe(0);
  });
});
