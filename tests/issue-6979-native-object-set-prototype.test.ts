// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  objectExtensibilityFixture,
  fillObjectExtensibilityDependencies,
  objectExtensibilityRuntime,
} from "./helpers/native-object-extensibility.js";
import {
  reserveNativeObjectSetPrototypeAlgorithm,
  requireNativeObjectSetPrototypeAlgorithm,
  fillNativeObjectSetPrototypeAlgorithm,
  requireCompletedNativeObjectSetPrototypeAlgorithm,
  requireNativeObjectExtensibilityAlgorithms,
} from "../src/backend/wasmgc/resources/native-object-structural-algorithms.js";
import { requireCompletedNativeObjectRealm } from "../src/backend/wasmgc/resources/native-object-realm.js";

afterEach(async () => await setImmediate());
for (const [displaced, decoded, mode] of [
  [false, false, "interned"],
  [true, true, "interned"],
  [false, false, "allocating"],
] as const)
  describe(`actual Object.setPrototypeOf displaced=${displaced} decoded=${decoded} boxes=${mode}`, () => {
    let r: ReturnType<typeof objectExtensibilityRuntime>;
    beforeAll(() => {
      r = objectExtensibilityRuntime(displaced, decoded, mode, true);
      console.info(
        "Object.setPrototypeOf component",
        JSON.stringify({
          displaced,
          decoded,
          mode,
          bytes: r.bytes.length,
          sha256: createHash("sha256").update(r.bytes).digest("hex"),
          imports: WebAssembly.Module.imports(r.wasm),
          reachable: r.liveNames.length,
          deadSnapshotBodies: r.stubbed,
          wholeRealmCompleted: r.wholeRealmCompleted,
        }),
      );
    }, 120000);
    const run = (values: readonly unknown[], stored = false) =>
      stored ? r.api.stored2(r.api.singleton2.value, null, r.vector(values)) : r.api.algorithm2(null, r.vector(values));
    const typeError = (action: () => unknown) => {
      let error: any;
      try {
        action();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(WebAssembly.Exception);
      expect(error.is(r.api.exception)).toBe(true);
      expect(r.api.errorTag(error.getArg(r.api.exception, 0))).toBe(-11);
    };
    const prototypeOf = (object: unknown) => {
      const [status, value] = r.api.getPrototypeOf(object);
      expect(status).toBe(1);
      return value;
    };
    it("executes the actual reserved slots, not a full or sealed realm", () => {
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.wholeRealmCompleted).toBe(false);
      expect(r.r.tx.state).toBe("filling");
      expect(r.r.prototypeAlgorithm!.entries.map((e) => e.request.intrinsic.id)).toEqual(["%Object.setPrototypeOf%"]);
      expect(requireCompletedNativeObjectSetPrototypeAlgorithm(r.r.tx, r.r.prototypeAlgorithm!)).toBe(
        r.r.prototypeAlgorithm,
      );
      expect(() => requireCompletedNativeObjectRealm(r.r.tx, r.r.realm.declarations)).toThrow(/incomplete/);
    });
    it("rejects nullish O before admitting even a foreign prototype", () => {
      typeError(() => run([]));
      for (const object of [null, r.api.undefinedValue()]) {
        typeError(() => run([object]));
        typeError(() => run([object, {}]));
      }
    });
    it("validates P before returning every non-null native primitive unchanged", () => {
      r.api.initialize();
      const primitives = [
        r.api.boxNumber(0),
        r.api.boxNumber(-0),
        r.api.boxNumber(NaN),
        r.api.boxNumber(Infinity),
        r.api.boxNumber(0.5),
        r.api.boxNumber(-(2 ** 30)),
        r.api.boxNumber(2 ** 30 - 1),
        r.api.boxNumber(2 ** 30),
        r.api.boxBoolean(0),
        r.api.boxBoolean(1),
        r.api.text(),
        r.api.symbol(82),
        r.api.zero(),
        r.api.negative(),
        r.api.wide96high(),
      ];
      const prototype = r.api.ordinary(0);
      for (const value of primitives) {
        expect(Object.is(run([value, null]), value)).toBe(true);
        expect(Object.is(run([value, prototype], true), value)).toBe(true);
        typeError(() => run([value]));
        for (const invalid of [r.api.undefinedValue(), r.api.boxNumber(7), r.api.text()])
          typeError(() => run([value, invalid], true));
      }
    });
    it("mutates the live state, ignores a stale prefix and preserves unrelated flags", () => {
      r.api.initialize();
      const object = r.api.ordinary(0),
        prototype = r.api.ordinary(0),
        stale = r.api.ordinary(0);
      r.api.setFlags(object, 0x5a5a5a80);
      r.api.fakePrefix(object, stale);
      expect(run([object, prototype])).toBe(object);
      expect(prototypeOf(object)).toBe(prototype);
      expect(r.api.flags(object)).toBe(0x5a5a5a80);
      expect(run([object, null], true)).toBe(object);
      expect(prototypeOf(object)).toBe(null);
    });
    it("uses actual wrappers, String and builtin singleton state without copying", () => {
      r.api.initialize();
      const prototype = r.api.ordinary(0);
      for (const object of [
        r.api.newBoolean(null, 1),
        r.api.newNumber(null, 42),
        r.api.newString(null, r.api.text()),
        r.api.newSymbol(null, r.api.symbol(82)),
        r.api.newBigInt(null, r.api.wide64()),
        r.api.singleton0.value,
      ]) {
        expect(run([object, prototype], true)).toBe(object);
        expect(prototypeOf(object)).toBe(prototype);
      }
    });
    it("allows SameValue on non-extensible objects but throws on a change", () => {
      r.api.initialize();
      const object = r.api.ordinary(0),
        prototype = r.api.ordinary(0);
      run([object, prototype]);
      r.api.algorithm1(null, r.vector([object]));
      expect(run([object, prototype], true)).toBe(object);
      typeError(() => run([object, null]));
      expect(prototypeOf(object)).toBe(prototype);
    });
    it("preserves immutable Object.prototype", () => {
      r.api.initialize();
      const object = r.api.objectPrototype.value;
      expect(run([object, null], true)).toBe(object);
      typeError(() => run([object, r.api.ordinary(0)]));
      expect(prototypeOf(object)).toBe(null);
    });
    it("rejects direct and long cycles while accepting a long acyclic chain", () => {
      r.api.initialize();
      const first = r.api.ordinary(0);
      typeError(() => run([first, first]));
      let tail = first;
      for (let i = 0; i < 105; i++) {
        const next = r.api.ordinary(0);
        expect(run([next, tail], true)).toBe(next);
        tail = next;
      }
      typeError(() => run([first, tail]));
      expect(prototypeOf(first)).toBe(null);
    });
    it("refuses foreign, fake, unready and stale values without inspecting host properties", () => {
      r.api.initialize();
      let reads = 0;
      const foreign = new Proxy(
        {},
        {
          get() {
            reads++;
            throw Error("foreign read");
          },
        },
      );
      for (const value of [
        undefined,
        false,
        "host",
        Symbol(),
        1n,
        foreign,
        r.api.ordinary(1),
        r.api.source(),
        r.api.undefinedCopy(),
      ]) {
        expect(() => run([value, null])).toThrow(WebAssembly.RuntimeError);
        expect(() => run([r.api.ordinary(0), value])).toThrow(WebAssembly.RuntimeError);
        expect(() => run([r.api.boxNumber(7), value])).toThrow(WebAssembly.RuntimeError);
      }
      const stale = r.api.ordinary(0);
      r.api.clearRealm();
      expect(() => run([stale, null])).toThrow(WebAssembly.RuntimeError);
      expect(reads).toBe(0);
    });
    it("refuses corrupt or foreign prototype chains, not a semantic false result", () => {
      r.api.initialize();
      const object = r.api.ordinary(0),
        a = r.api.ordinary(0),
        b = r.api.ordinary(0);
      r.api.corruptParent(a, b);
      r.api.corruptParent(b, a);
      expect(() => run([object, a])).toThrow(WebAssembly.RuntimeError);
      r.api.corruptParent(a, r.api.ordinary(1));
      expect(() => run([object, a])).toThrow(WebAssembly.RuntimeError);
      expect(prototypeOf(object)).toBe(null);
    });
    it("checks lifted self metadata, realm and exact singleton identity", () => {
      r.api.initialize();
      const argv = r.vector([r.api.boxNumber(7), null]);
      // Ordinary objects are incompatible at the JS/Wasm boundary. Other
      // builtins have a compatible GC shape, so their wrong identity/metadata
      // must instead be rejected by the actual native guard.
      expect(() => r.api.lifted2(r.api.ordinary(0), null, argv)).toThrow(
        /type incompatibility when transforming from\/to JS/,
      );
      const id = r.r.prototypeAlgorithm!.entries[0]!.metadata.metadata.id;
      for (const self of [
        r.api.singleton0.value,
        r.api.singleton1.value,
        r.api.native2(id + 1, 0),
        r.api.native2(id, 0),
        r.api.native2(id, 1),
      ])
        typeError(() => r.api.lifted2(self, null, argv));
      expect(r.api.lifted2(r.api.singleton2.value, null, argv)).toBe(7);
      r.api.clearRealm();
      typeError(() => r.api.lifted2(r.api.singleton2.value, null, argv));
    });
  });

describe("canonical Object.setPrototypeOf owner", () => {
  const fixture = () => objectExtensibilityFixture(false, false, "interned", true);
  it("coexists with extensibility but rejects duplicates, copies and wrong scopes", () => {
    const r = fixture(),
      count = r.f.module.functions.length,
      pack = r.prototypeAlgorithm!;
    expect(requireNativeObjectSetPrototypeAlgorithm(r.tx, pack, r.realm.declarations)).toBe(pack);
    expect(() => reserveNativeObjectSetPrototypeAlgorithm(r.tx, r.algorithmDependencies)).toThrow(/already/);
    expect(r.f.module.functions.length).toBe(count);
    expect(() => requireNativeObjectSetPrototypeAlgorithm(r.tx, { ...pack }, r.realm.declarations)).toThrow(/copied/);
    expect(() => requireNativeObjectSetPrototypeAlgorithm(r.tx, r.algorithms as any, r.realm.declarations)).toThrow(
      /wrong-scope/,
    );
    expect(() => requireNativeObjectExtensibilityAlgorithms(r.tx, pack as any, r.realm.declarations)).toThrow(
      /wrong-scope/,
    );
    const other = fixture();
    expect(() => requireNativeObjectSetPrototypeAlgorithm(other.tx, pack, r.realm.declarations)).toThrow(/foreign/);
    expect(() => requireNativeObjectSetPrototypeAlgorithm(r.tx, pack, other.realm.declarations)).toThrow(
      /different expected realm/,
    );
  });
  it("does not certify reserved slots or fill before prerequisites", () => {
    const r = fixture();
    expect(() => requireCompletedNativeObjectSetPrototypeAlgorithm(r.tx, r.prototypeAlgorithm!)).toThrow(
      /missing canonical/,
    );
    r.tx.freezeReservations();
    expect(() => fillNativeObjectSetPrototypeAlgorithm(r.tx, r.prototypeAlgorithm!)).toThrow(/canonical|incomplete/);
  });
  it.each(["algorithm", "lifted"] as const)("re-derives %s independently of valid allocator receipts", (kind) => {
    const r = fixture();
    fillObjectExtensibilityDependencies(r);
    const fill = r.tx.fillFunction.bind(r.tx),
      target = r.prototypeAlgorithm!.entries[0]![kind];
    r.tx.fillFunction = (token, definition) =>
      fill(token, token === target ? { locals: [], body: [{ op: "ref.null.extern" }] } : definition);
    fillNativeObjectSetPrototypeAlgorithm(r.tx, r.prototypeAlgorithm!);
    r.tx.assertCompletedReservation(target);
    expect(() => requireCompletedNativeObjectSetPrototypeAlgorithm(r.tx, r.prototypeAlgorithm!)).toThrow(
      /noncanonical function definition/,
    );
  });
  it("cannot retry a partially filled owner into completion", () => {
    const r = fixture();
    fillObjectExtensibilityDependencies(r);
    const fill = r.tx.fillFunction.bind(r.tx),
      target = r.prototypeAlgorithm!.entries[0]!.lifted;
    r.tx.fillFunction = (token, definition) => {
      if (token === target) throw Error("partial fill interruption");
      fill(token, definition);
    };
    expect(() => fillNativeObjectSetPrototypeAlgorithm(r.tx, r.prototypeAlgorithm!)).toThrow(/partial fill/);
    r.tx.fillFunction = fill;
    expect(() => fillNativeObjectSetPrototypeAlgorithm(r.tx, r.prototypeAlgorithm!)).toThrow(/failed fill/);
    expect(() => requireCompletedNativeObjectSetPrototypeAlgorithm(r.tx, r.prototypeAlgorithm!)).toThrow(
      /missing canonical/,
    );
  });
});
