// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EXOTIC_TEXTS } from "./helpers/native-string-exotic-fixture.js";
import {
  CREATE_TEXTS,
  stringCreateFixture,
  stringCreateRuntime,
  completeStringCreateFixture,
  fillStringCreateDependencies,
  type StringCreateRuntime,
} from "./helpers/native-string-create-fixture.js";
import { buildStringCreateDefinition } from "../src/runtime/wasmgc/values/string-create-body.js";
import {
  declareNativeStringCreateResources,
  reserveNativeStringCreateResources,
  requireNativeStringCreateReservations,
  fillNativeStringCreateResources,
  requireCompletedNativeStringCreate,
} from "../src/backend/wasmgc/resources/native-string-create.js";
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
const key = (e: StringCreateRuntime, text: string) => {
  const index = EXOTIC_TEXTS.indexOf(text);
  if (index < 0) throw Error("unreserved key " + text);
  return e.key(index);
};
for (const utf8 of [false, true])
  for (const shifted of [false, true]) {
    describe(`real native StringCreate utf8=${utf8} shifted=${shifted} minimum capacity=2`, () => {
      let e: StringCreateRuntime;
      beforeAll(async () => {
        e = stringCreateRuntime(utf8, shifted, 2).runtime;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }, 35000);
      it.each(CREATE_TEXTS.map((text, index) => [text, index] as const))(
        "creates the exact length descriptor for %j",
        (text, index) => {
          const payload = e.text(index);
          expect(e.isUtf8(payload)).toBe(utf8 && !text.includes("\ud800") ? 1 : 0);
          for (const proto of [null, e.root()]) {
            const object = e.make(proto, payload),
              descriptor = Object.getOwnPropertyDescriptor(Object(text), "length")!;
            expect(e.prototype(object)).toBe(proto);
            expect(e.payload(object)).toBe(payload);
            expect(e.lengthValue(object)).toBe(descriptor.value);
            expect(e.lengthFlags(object)).toBe(
              (descriptor.writable ? 1 : 0) | (descriptor.enumerable ? 2 : 0) | (descriptor.configurable ? 4 : 0),
            );
            expect(e.lengthSeq(object)).toBe(0);
            expect([e.count(object), e.tombstones(object), e.flags(object), e.nextSeq(object)]).toEqual([
              1,
              0,
              proto === null ? 128 : 0,
              1,
            ]);
            expect(e.absent(object)).toBe(1); // an actual raw lookup after filling the minimum admitted map
          }
        },
      );
      it("distinguishes explicit null from an unresolved real realm prototype and traverses String ancestors", () => {
        const text = e.text(2),
          explicit = e.make(null, text),
          inherited = e.make(e.implicitRoot(), text);
        expect(e.lookupStatus(explicit, key(e, "own"))).toBe(0);
        expect(e.lookupStatus(inherited, key(e, "own"))).toBe(2);
        const child = e.make(explicit, e.text(0));
        expect(e.prototype(child)).toBe(explicit);
        expect(e.lookupStatus(child, key(e, "0"))).toBe(1);
        expect(e.lookupStatus(child, key(e, "own"))).toBe(0);
      });
      it("allocates fresh objects and maps while retaining the same payload and prototype", () => {
        const prototype = e.root(),
          payload = e.text(2),
          a = e.make(prototype, payload),
          b = e.make(prototype, payload);
        expect(Object.is(a, b)).toBe(false);
        expect(e.sameObject(a, b)).toBe(0);
        expect(e.sameObject(a, a)).toBe(1);
        expect(Object.is(e.table(a), e.table(b))).toBe(false);
        expect(e.sameTable(a, b)).toBe(0);
        expect(e.sameTable(a, a)).toBe(1);
        expect(e.prototype(a)).toBe(prototype);
        expect(e.prototype(b)).toBe(prototype);
        expect(e.payload(a)).toBe(payload);
        expect(e.payload(b)).toBe(payload);
      });
      it("retains virtual UTF16 characters without mutating length storage", () => {
        const text = CREATE_TEXTS[3],
          payload = e.text(3),
          object = e.make(null, payload),
          table = e.table(object);
        for (let i = 0; i < text.length; i++) {
          expect(e.ownFlags(object, key(e, String(i)))).toBe(2);
          expect(e.codeUnit(e.ownValue(object, key(e, String(i))), 0)).toBe(text.charCodeAt(i));
        }
        expect(e.table(object)).toBe(table);
        expect(e.payload(object)).toBe(payload);
        expect([e.count(object), e.tombstones(object), e.nextSeq(object)]).toEqual([1, 0, 1]);
        expect(e.ownFlags(object, key(e, "5"))).toBe(-1);
      });
      it("reads actual UTF8 astral payloads through the shared virtual-descriptor owner", () => {
        const payload = e.text(2),
          object = e.make(null, payload);
        expect(e.isUtf8(payload)).toBe(utf8 ? 1 : 0);
        expect(e.lengthValue(object)).toBe(2);
        for (let i = 0; i < 2; i++)
          expect(e.codeUnit(e.ownValue(object, key(e, String(i))), 0)).toBe("😀".charCodeAt(i));
        expect(e.payload(object)).toBe(payload);
        expect(e.count(object)).toBe(1);
      });
      it("retains original slices and mixed-encoding cons payloads", () => {
        const slice = e.slice(),
          a = e.make(null, slice),
          rope = e.rope(e.text(1), e.text(2)),
          b = e.make(null, rope);
        expect(e.payload(a)).toBe(slice);
        expect(e.lengthValue(a)).toBe(5);
        expect(e.payload(b)).toBe(rope);
        expect(e.lengthValue(b)).toBe(3);
        for (const [object, text] of [
          [a, "é😀\ud800\0"],
          [b, "a😀"],
        ] as const)
          for (let i = 0; i < text.length; i++)
            expect(e.codeUnit(e.ownValue(object, key(e, String(i))), 0)).toBe(text.charCodeAt(i));
      });
      it.each([0x3fffffff, 0x40000000, 0x7fffffff, 0x80000000, 0xffffffff])(
        "boxes unsigned header length %s exactly",
        (length) => {
          // Header arithmetic control, separately from genuinely allocated native text carriers.
          const payload = e.header(length),
            object = e.make(null, payload);
          expect(e.lengthValue(object)).toBe(length);
          expect(e.lengthFlags(object)).toBe(0);
          expect(e.payload(object)).toBe(payload);
          expect(e.absent(object)).toBe(1);
        },
      );
      it("keeps length first while adding an ordinary expando through real growth/insertion", () => {
        const object = e.make(null, e.text(1));
        e.put(object, key(e, "own"), 42);
        expect(e.lengthSeq(object)).toBe(0);
        expect(e.lengthFlags(object)).toBe(0);
        expect(e.lengthValue(object)).toBe(1);
        expect(e.ownValue(object, key(e, "own"))).toBe(42);
        expect(e.count(object)).toBe(2);
        expect(e.nextSeq(object)).toBe(2);
        expect(e.ownFlags(object, key(e, "0"))).toBe(2);
      });
      it("rejects foreign or undefined prototypes and non-native payloads", () => {
        for (const proto of [undefined, {}, 0, "x"]) expect(() => e.make(proto, e.text(1))).toThrow();
        for (const payload of [undefined, null, {}, "x"]) expect(() => e.make(null, payload)).toThrow();
        expect(e.lengthValue(e.make(null, e.text(1)))).toBe(1);
      });
    });
  }
describe("authenticated StringCreate reservation and completion", () => {
  it("requires all real prerequisite bodies, then completes only the issued constructor", () => {
    const f = stringCreateFixture();
    expect(f.module.exports).toEqual([]);
    expect(() => requireCompletedNativeStringCreate(f.tx, f.create, f.createDependencies)).toThrow(
      "missing canonical fill",
    );
    f.tx.freezeReservations();
    expect(() => fillNativeStringCreateResources(f.tx, f.create)).toThrow();
    fillStringCreateDependencies(f);
    fillNativeStringCreateResources(f.tx, f.create);
    expect(requireCompletedNativeStringCreate(f.tx, f.create, f.createDependencies)).toBe(f.create);
    expect(f.create.completionScope).toBe("string-create-own-length");
    expect(() => fillNativeStringCreateResources(f.tx, f.create)).toThrow("duplicate fill");
  });
  it.each([1, 0, 3, -1, 1.5, NaN, Infinity, 0x80000000])(
    "refuses invalid/one-slot capacity %s before reserving",
    (capacity) => {
      const f = stringCreateFixture(),
        before = structuredClone(f.module);
      expect(() => declareNativeStringCreateResources("bad", "strings:any", capacity)).toThrow("capacity");
      const invalid = { ...f.createPlan, initialCapacity: capacity };
      expect(() => reserveNativeStringCreateResources(f.tx, "bad", invalid, f.createDependencies)).toThrow("capacity");
      expect(f.module).toStrictEqual(before);
    },
  );
  it.each(["layouts", "storage", "values", "ownDescriptors"] as const)(
    "refuses copied %s without allocation",
    (role) => {
      const f = stringCreateFixture(),
        before = structuredClone(f.module),
        dependencies = { ...f.createDependencies, [role]: { ...f.createDependencies[role] } };
      expect(() => reserveNativeStringCreateResources(f.tx, "bad", f.createPlan, dependencies)).toThrow();
      expect(f.module).toStrictEqual(before);
    },
  );
  it("refuses copied/foreign owners and changed expected dependencies", () => {
    const f = stringCreateFixture(),
      other = stringCreateFixture();
    expect(requireNativeStringCreateReservations(f.tx, f.create, f.createDependencies)).toBe(f.create);
    expect(() => requireNativeStringCreateReservations(f.tx, { ...f.create }, f.createDependencies)).toThrow(
      "unissued",
    );
    expect(() => requireNativeStringCreateReservations(other.tx, f.create, f.createDependencies)).toThrow("foreign");
    expect(() => requireNativeStringCreateReservations(f.tx, f.create, { ...f.createDependencies })).toThrow(
      "foreign expected",
    );
  });
  it("refuses plan/capacity, dependency and completed body changes", () => {
    const a = stringCreateFixture(false, false, 2, true);
    (a.createPlan as { initialCapacity: number }).initialCapacity = 4;
    expect(() => requireNativeStringCreateReservations(a.tx, a.create, a.createDependencies)).toThrow(
      "changed declaration",
    );
    const b = stringCreateFixture();
    Object.assign(b.createDependencies, { storage: { ...b.storage } });
    expect(() => requireNativeStringCreateReservations(b.tx, b.create, b.createDependencies)).toThrow(
      "substituted dependency",
    );
    const c = completeStringCreateFixture();
    c.create.create.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeStringCreate(c.tx, c.create, c.createDependencies)).toThrow("altered completed");
  });
  it("refuses accessor dependencies without invoking them", () => {
    const f = stringCreateFixture(),
      before = structuredClone(f.module),
      d = { ...f.createDependencies };
    let calls = 0;
    Object.defineProperty(d, "values", {
      get() {
        calls++;
        return f.values;
      },
    });
    expect(() => reserveNativeStringCreateResources(f.tx, "bad", f.createPlan, d)).toThrow("non-data");
    expect(calls).toBe(0);
    expect(f.module).toStrictEqual(before);
  });
  it.each([undefined, -1, NaN, 1.5, Infinity, 0x100000000])("refuses malformed pure coordinates %s", (boxNumberIdx) => {
    expect(() =>
      buildStringCreateDefinition({
        objectTypeIdx: 1,
        stringObjectTypeIdx: 2,
        propMapTypeIdx: 3,
        anyStringTypeIdx: 4,
        insertIdx: 1,
        boxNumberIdx: boxNumberIdx as number,
        initialCapacity: 2,
        lengthKey: { kind: "global", index: 1 },
      }),
    ).toThrow("invalid coordinate");
  });
});
