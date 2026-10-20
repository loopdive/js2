// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  objectExtensibilityFixture,
  objectExtensibilityRuntimeSteps,
  fillObjectExtensibilityDependencies,
} from "./helpers/native-object-extensibility.js";
import {
  reserveNativeObjectIntegrityAlgorithms,
  requireNativeObjectIntegrityAlgorithms,
  fillNativeObjectIntegrityAlgorithms,
  requireCompletedNativeObjectIntegrityAlgorithms,
} from "../src/backend/wasmgc/resources/native-object-integrity.js";
import { requireCompletedNativeObjectRealm } from "../src/backend/wasmgc/resources/native-object-realm.js";

afterEach(async () => await setImmediate());
for (const [displaced, decoded, mode] of [
  [false, false, "interned"],
  [true, true, "allocating"],
] as const)
  describe(`real native integrity slots displaced=${displaced} decoded=${decoded} mode=${mode}`, () => {
    const preparation = objectExtensibilityRuntimeSteps(
      displaced,
      decoded,
      mode,
      false,
      false,
      false,
      false,
      false,
      true,
    );
    let r: ReturnType<typeof preparation.next>["value"];
    for (let phase = 0; phase < 10; phase++)
      beforeAll(async () => {
        const step = preparation.next();
        expect(step.done, "preparation phase " + phase).toBe(phase === 9);
        if (step.done) r = step.value;
        await setImmediate();
      }, 120000);
    beforeEach(() => r!.api.initialize());
    const call = (method: number, value: unknown, stored = true) => {
      const index = method + 2,
        args = r!.vector([value]);
      return stored
        ? r!.api["stored" + index](r!.api["singleton" + index].value, null, args)
        : r!.api["algorithm" + index](null, args);
    };
    const query = (method: 2 | 3, value: unknown) => r!.api.readBoolean(call(method, value));
    const add = (object: unknown, key: unknown, value: unknown, flags: number) => {
      r!.api.integrityInsert(object, key, value, flags);
      const entry = r!.api.integrityEntry(object, key);
      expect(entry).not.toBeNull();
      return entry;
    };
    it("executes all eight real catalog slots and five internal operations without full realm completion", () => {
      expect(WebAssembly.Module.imports(r!.wasm)).toEqual([]);
      const pack = r!.r.integrity!;
      expect(pack.entries.map((e) => e.request.intrinsic.id)).toEqual([
        "%Object.freeze%",
        "%Object.seal%",
        "%Object.isFrozen%",
        "%Object.isSealed%",
      ]);
      for (const token of [pack.storage, ...pack.operations, ...pack.entries.flatMap((e) => [e.algorithm, e.lifted])])
        expect(r!.liveNames).toContain(token.object.name);
      expect(requireCompletedNativeObjectIntegrityAlgorithms(r!.r.tx, pack, r!.r.algorithmDependencies)).toBe(pack);
      expect(() => requireCompletedNativeObjectRealm(r!.r.tx, pack.realm)).toThrow(/incomplete/);
      expect(r!.wholeRealmCompleted).toBe(false);
    });
    it("returns true for primitive queries and preserves exact primitive identity for both mutations", () => {
      for (const value of [
        null,
        r!.api.undefinedValue(),
        r!.api.boxNumber(0),
        r!.api.boxNumber(-0),
        r!.api.boxNumber(NaN),
        r!.api.boxNumber(0.5),
        r!.api.boxBoolean(0),
        r!.api.boxBoolean(1),
        r!.api.text(),
        r!.api.symbol(91),
        r!.api.wide96high(),
      ]) {
        for (const stored of [false, true]) {
          expect(Object.is(call(0, value, stored), value)).toBe(true);
          expect(Object.is(call(1, value, stored), value)).toBe(true);
        }
        expect(query(2, value)).toBe(1);
        expect(query(3, value)).toBe(1);
      }
      for (const method of [0, 1, 2, 3]) {
        const result = r!.api["algorithm" + (method + 2)](null, r!.vector([]));
        expect(method < 2 ? Object.is(result, r!.api.undefinedValue()) : r!.api.readBoolean(result) === 1).toBe(true);
      }
    });
    it("tests live descriptors rather than cached frozen/sealed bits", () => {
      const object = r!.api.ordinary(0),
        entry = add(object, r!.api.text(), r!.api.boxNumber(8), 7);
      r!.api.setFlags(object, 0x4087);
      expect(query(2, object)).toBe(0);
      expect(query(3, object)).toBe(0);
      r!.api.integritySetEntryFlags(entry, 3);
      expect(query(3, object)).toBe(1);
      expect(query(2, object)).toBe(0);
      r!.api.integritySetEntryFlags(entry, 2);
      expect(query(2, object)).toBe(1);
      r!.api.setFlags(object, 0x4086);
      expect(query(2, object)).toBe(0);
      expect(query(3, object)).toBe(0);
    });
    it("freezes string/symbol data descriptors but retains accessor identity and irrelevant writable bits", () => {
      const object = r!.api.ordinary(0),
        payload = r!.api.boxNumber(-0);
      const data = add(object, r!.api.text(), payload, 0x4007),
        symbol = add(object, r!.api.symbol(1), payload, 0x2007);
      const accessor = add(object, r!.api.symbol(2), payload, 0x100d);
      const getter = r!.api.singleton0.value,
        setter = r!.api.singleton1.value;
      r!.api.integrityAccessor(accessor, getter, setter);
      r!.api.setFlags(object, 0x5280);
      expect(call(0, object)).toBe(object);
      expect(r!.api.flags(object)).toBe(0x5287);
      expect(r!.api.integrityEntryFlags(data)).toBe(0x4002);
      expect(r!.api.integrityEntryFlags(symbol)).toBe(0x2002);
      expect(r!.api.integrityEntryFlags(accessor)).toBe(0x1009);
      expect(r!.api.integrityEntryValue(data)).toBe(payload);
      expect(r!.api.integrityGetter(accessor)).toBe(getter);
      expect(r!.api.integritySetter(accessor)).toBe(setter);
      expect(query(2, object)).toBe(1);
      expect(query(3, object)).toBe(1);
      expect(call(0, object, false)).toBe(object);
    });
    it("seals without freezing writable data, then freezes the same live object", () => {
      const object = r!.api.ordinary(0),
        entry = add(object, r!.api.text(), r!.api.boxNumber(5), 7);
      expect(call(1, object, false)).toBe(object);
      expect(r!.api.integrityEntryFlags(entry)).toBe(3);
      expect(query(3, object)).toBe(1);
      expect(query(2, object)).toBe(0);
      expect(call(0, object)).toBe(object);
      expect(r!.api.integrityEntryFlags(entry)).toBe(2);
      expect(query(2, object)).toBe(1);
    });
    it("ignores tombstones without mutating them and prevents insertion of new keys", () => {
      const object = r!.api.ordinary(0),
        key = r!.api.text();
      const dead = add(object, key, null, 7);
      r!.api.integritySetEntryFlags(dead, 135);
      call(0, object);
      expect(r!.api.integrityEntryFlags(dead)).toBe(135);
      expect(query(2, object)).toBe(1);
      r!.api.integrityInsert(object, r!.api.symbol(3), null, 7);
      expect(r!.api.integrityEntry(object, r!.api.symbol(3))).toBeNull();
    });
    it("handles each genuine primitive-wrapper storage and immutable String virtual descriptors", () => {
      const string = r!.api.newString(null, r!.api.text());
      const length = r!.api.integrityStringEntry(string, r!.api.integrityLengthKey());
      const index = () => r!.api.integrityStringEntry(string, r!.api.integrityIndexKey());
      const original = r!.api.integrityEntryValue(index());
      expect(r!.api.integrityEntryFlags(index())).toBe(2);
      for (const object of [
        r!.api.newBoolean(null, 1),
        r!.api.newNumber(null, -0),
        r!.api.newSymbol(null, r!.api.symbol(4)),
        r!.api.newBigInt(null, r!.api.wide96high()),
        string,
      ]) {
        add(object, r!.api.symbol(10), r!.api.boxNumber(4), 7);
        expect(call(1, object)).toBe(object);
        expect(query(3, object)).toBe(1);
        expect(query(2, object)).toBe(0);
        call(0, object);
        expect(query(2, object)).toBe(1);
      }
      expect(r!.api.integrityEntryFlags(length)).toBe(0);
      expect(r!.api.integrityEntryFlags(index())).toBe(2);
      // Virtual index reads allocate descriptors but keep their exact String value.
      expect(r!.api.isPrimitive(original)).toBe(1);
    });
    it("keeps unready populations and foreign carriers explicit, without user hooks", () => {
      let hooks = 0;
      const trap = () => {
        hooks++;
        throw Error("unexpected host hook");
      };
      const hostile = new Proxy({}, { get: trap, ownKeys: trap, getPrototypeOf: trap });
      for (const value of [
        {},
        hostile,
        new Number(7),
        true,
        undefined,
        "name",
        0.5,
        r!.api.undefinedCopy(),
        r!.api.ordinary(1),
        r!.api.source(),
        r!.api.singleton0.value,
        r!.api.objectPrototype.value,
      ]) {
        for (const method of [0, 1, 2, 3]) expect(() => call(method, value)).toThrow(WebAssembly.RuntimeError);
      }
      expect(r!.api.integrityKernel0(r!.api.singleton0.value)).toBe(2);
      expect(r!.api.integrityKernel2(hostile)).toBe(3);
      expect(hooks).toBe(0);
    });
    it("ignores receiver and tail values without granting them authority", () => {
      let hooks = 0;
      const hostile = new Proxy(
        {},
        {
          get() {
            hooks++;
            throw Error("unused receiver");
          },
        },
      );
      const object = r!.api.ordinary(0);
      expect(r!.api.algorithm2(hostile, r!.vector([object, hostile]))).toBe(object);
      expect(hooks).toBe(0);
    });
    it("preserves live prototype identity and never freezes a referenced parent", () => {
      const object = r!.api.ordinary(0),
        parent = r!.api.ordinary(0);
      expect(r!.api.internalSetPrototypeOf(object, parent)).toBe(1);
      expect(r!.api.getPrototypeOf(object)).toEqual([1, parent]);
      expect(call(0, object)).toBe(object);
      expect(r!.api.getPrototypeOf(object)).toEqual([1, parent]);
      expect(query(2, object)).toBe(1);
      expect(query(2, parent)).toBe(0);
    });
    it("uses the actual guarded Call identity and tagged TypeError", () => {
      for (const method of [0, 1, 2, 3]) {
        let caught: WebAssembly.Exception | undefined;
        try {
          r!.api["lifted" + (method + 2)](r!.api.singleton0.value, null, r!.vector([r!.api.ordinary(0)]));
        } catch (error) {
          caught = error as WebAssembly.Exception;
        }
        expect(caught).toBeInstanceOf(WebAssembly.Exception);
        expect(caught!.is(r!.api.exception)).toBe(true);
        expect(r!.api.errorTag(caught!.getArg(r!.api.exception, 0))).toBe(-11);
      }
    });
  });

describe("integrity algorithm owner custody", () => {
  it("refuses copied owners, alternate dependency records and duplicate producers", () => {
    const f = objectExtensibilityFixture(false, false, "interned", false, false, false, false, false, true);
    const before = [f.f.module.functions.length, f.f.module.types.length];
    expect(() => requireNativeObjectIntegrityAlgorithms(f.tx, { ...f.integrity! }, f.algorithmDependencies)).toThrow(
      /copied/,
    );
    expect(() => requireNativeObjectIntegrityAlgorithms(f.tx, f.integrity!, { ...f.algorithmDependencies })).toThrow(
      /different original/,
    );
    expect(() => reserveNativeObjectIntegrityAlgorithms(f.tx, f.algorithmDependencies)).toThrow(/already/);
    expect([f.f.module.functions.length, f.f.module.types.length]).toEqual(before);
    expect(() => requireCompletedNativeObjectIntegrityAlgorithms(f.tx, f.integrity!, f.algorithmDependencies)).toThrow(
      /canonical algorithm fill/,
    );
  });
  describe("receipt-valid substituted kernel", () => {
    let f: ReturnType<typeof objectExtensibilityFixture>;
    let changed = 0;
    beforeAll(() => {
      f = objectExtensibilityFixture(false, false, "interned", false, false, false, false, false, true);
    });
    beforeEach(() => {
      fillObjectExtensibilityDependencies(f);
      const fill = f.tx.fillFunction.bind(f.tx);
      f.tx.fillFunction = (token, body) => {
        if (token === f.integrity!.operations[0]) {
          changed++;
          fill(token, { locals: [], body: [{ op: "i32.const", value: 1 }] });
        } else fill(token, body);
      };
    });
    it("refuses receipt-valid kernel substitution before semantic completion", () => {
      fillNativeObjectIntegrityAlgorithms(f.tx, f.integrity!);
      expect(changed).toBe(1);
      f.tx.assertCompletedReservation(f.integrity!.operations[0]!);
      expect(() =>
        requireCompletedNativeObjectIntegrityAlgorithms(f.tx, f.integrity!, f.algorithmDependencies),
      ).toThrow(/noncanonical function definition/);
    });
  });
});
