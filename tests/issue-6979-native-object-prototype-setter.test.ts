// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  objectExtensibilityFixture,
  fillObjectExtensibilityDependencies,
  objectExtensibilityRuntime,
  objectExtensibilityRuntimeAsync,
} from "./helpers/native-object-extensibility.js";
import {
  reserveNativeObjectPrototypeSetterAlgorithm,
  requireNativeObjectPrototypeSetterAlgorithm,
  fillNativeObjectPrototypeSetterAlgorithm,
  requireCompletedNativeObjectPrototypeSetterAlgorithm,
  requireNativeObjectSetPrototypeAlgorithm,
} from "../src/backend/wasmgc/resources/native-object-structural-algorithms.js";
import { requireCompletedNativeObjectRealm } from "../src/backend/wasmgc/resources/native-object-realm.js";

afterEach(async () => await setImmediate());
for (const [displaced, decoded, mode] of [
  [false, false, "interned"],
  [true, true, "interned"],
  [false, false, "allocating"],
] as const)
  describe(`retained __proto__ setter displaced=${displaced} decoded=${decoded} boxes=${mode}`, () => {
    let r: ReturnType<typeof objectExtensibilityRuntime>;
    beforeAll(async () => {
      r = await objectExtensibilityRuntimeAsync(displaced, decoded, mode, true, true);
      console.info(
        "Object prototype setter component",
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
    const run = (receiver: unknown, args: readonly unknown[], stored = false) =>
      stored
        ? r.api.stored3(r.api.singleton3.value, receiver, r.vector(args))
        : r.api.algorithm3(receiver, r.vector(args));
    const prototypeOf = (object: unknown) => {
      const [status, value] = r.api.getPrototypeOf(object);
      expect(status).toBe(1);
      return value;
    };
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
    const primitives = () => [
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
    it("fills actual retained catalog slots without completing or sealing the realm", () => {
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.wholeRealmCompleted).toBe(false);
      expect(r.r.tx.state).toBe("filling");
      const pack = r.r.prototypeSetter!;
      expect(pack.entries.map((e) => [e.request.intrinsic.id, e.request.intrinsic.callable.length])).toEqual([
        ["%set Object.prototype.__proto__%", 1],
      ]);
      expect(requireCompletedNativeObjectPrototypeSetterAlgorithm(r.r.tx, pack)).toBe(pack);
      expect(() => requireCompletedNativeObjectRealm(r.r.tx, r.r.realm.declarations)).toThrow(/incomplete/);
    });
    it("rejects nullish this before considering invalid, missing or foreign P", () => {
      for (const receiver of [null, r.api.undefinedValue()]) {
        typeError(() => run(receiver, []));
        typeError(() => run(receiver, [r.api.boxNumber(7)]));
        typeError(() => run(receiver, [{}]));
      }
    });
    it("returns canonical undefined for every non-null native primitive receiver", () => {
      r.api.initialize();
      const parent = r.api.ordinary(0),
        undefinedValue = r.api.undefinedValue();
      for (const receiver of primitives()) {
        expect(run(receiver, [null])).toBe(undefinedValue);
        expect(run(receiver, [parent], true)).toBe(undefinedValue);
        expect(run(receiver, [], true)).toBe(undefinedValue);
        for (const p of primitives()) expect(run(receiver, [p])).toBe(undefinedValue);
      }
    });
    it("ignores invalid native primitive prototypes, including missing canonical undefined", () => {
      r.api.initialize();
      const object = r.api.ordinary(0),
        parent = r.api.ordinary(0);
      run(object, [parent]);
      r.api.setFlags(object, 0x5a5a5a80);
      for (const p of [r.api.undefinedValue(), ...primitives()]) {
        expect(run(object, [p], true)).toBe(r.api.undefinedValue());
        expect(prototypeOf(object)).toBe(parent);
        expect(r.api.flags(object)).toBe(0x5a5a5a80);
      }
      expect(run(object, [])).toBe(r.api.undefinedValue());
      expect(prototypeOf(object)).toBe(parent);
    });
    it("uses this and argv[0], preserves live state/flags and ignores extra arguments", () => {
      r.api.initialize();
      let reads = 0;
      const ignored = new Proxy(
        {},
        {
          get() {
            reads++;
            throw Error("ignored argument read");
          },
        },
      );
      const object = r.api.ordinary(0),
        parent = r.api.ordinary(0),
        stale = r.api.ordinary(0);
      r.api.fakePrefix(object, stale);
      r.api.setFlags(object, 0x5a5a5a80);
      expect(run(object, [parent, ...Array(104).fill(ignored)], true)).toBe(r.api.undefinedValue());
      expect(prototypeOf(object)).toBe(parent);
      expect(prototypeOf(parent)).toBe(null);
      expect(r.api.flags(object)).toBe(0x5a5a5a80);
      expect(run(object, [null])).toBe(r.api.undefinedValue());
      expect(prototypeOf(object)).toBe(null);
      expect(reads).toBe(0);
    });
    it("mutates native wrappers, String and builtin singleton state without copying", () => {
      r.api.initialize();
      const parent = r.api.ordinary(0);
      for (const object of [
        r.api.newBoolean(null, 1),
        r.api.newNumber(null, 42),
        r.api.newString(null, r.api.text()),
        r.api.newSymbol(null, r.api.symbol(82)),
        r.api.newBigInt(null, r.api.wide64()),
        r.api.singleton0.value,
      ]) {
        expect(run(object, [parent], true)).toBe(r.api.undefinedValue());
        expect(prototypeOf(object)).toBe(parent);
      }
    });
    it("preserves SameValue-first, non-extensibility and immutable Object.prototype rules", () => {
      r.api.initialize();
      const object = r.api.ordinary(0),
        parent = r.api.ordinary(0),
        undefinedValue = r.api.undefinedValue();
      run(object, [parent]);
      r.api.algorithm1(null, r.vector([object]));
      expect(run(object, [parent], true)).toBe(undefinedValue);
      typeError(() => run(object, [null]));
      expect(prototypeOf(object)).toBe(parent);
      const intrinsic = r.api.objectPrototype.value;
      expect(run(intrinsic, [null], true)).toBe(undefinedValue);
      typeError(() => run(intrinsic, [parent]));
      expect(prototypeOf(intrinsic)).toBe(null);
    });
    it("rejects direct/long cycles and refuses corrupt or unready chains without mutation", () => {
      r.api.initialize();
      const first = r.api.ordinary(0);
      typeError(() => run(first, [first]));
      let tail = first;
      for (let i = 0; i < 105; i++) {
        const next = r.api.ordinary(0);
        expect(run(next, [tail], true)).toBe(r.api.undefinedValue());
        tail = next;
      }
      typeError(() => run(first, [tail]));
      const a = r.api.ordinary(0),
        b = r.api.ordinary(0);
      r.api.corruptParent(a, b);
      r.api.corruptParent(b, a);
      expect(() => run(first, [a])).toThrow(WebAssembly.RuntimeError);
      r.api.corruptParent(a, r.api.ordinary(1));
      expect(() => run(first, [a])).toThrow(WebAssembly.RuntimeError);
      expect(prototypeOf(first)).toBe(null);
    });
    it("refuses foreign, fake, unready and stale private inputs without host reads", () => {
      r.api.initialize();
      let reads = 0;
      const foreign = new Proxy(
        {},
        {
          get() {
            reads++;
            throw Error("foreign property read");
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
        expect(() => run(value, [null])).toThrow(WebAssembly.RuntimeError);
        expect(() => run(value, [r.api.boxNumber(7)])).toThrow(WebAssembly.RuntimeError);
        expect(() => run(r.api.ordinary(0), [value])).toThrow(WebAssembly.RuntimeError);
        expect(() => run(r.api.boxNumber(7), [value])).toThrow(WebAssembly.RuntimeError);
      }
      const object = r.api.ordinary(0);
      r.api.clearRealm();
      expect(() => run(object, [null])).toThrow(WebAssembly.RuntimeError);
      expect(reads).toBe(0);
    });
    it("authenticates lifted metadata, same-type clones, realm and exact self identity", () => {
      r.api.initialize();
      const receiver = r.api.ordinary(0),
        argv = r.vector([null]);
      expect(() => r.api.lifted3(receiver, receiver, argv)).toThrow(
        /type incompatibility when transforming from\/to JS/,
      );
      const id = r.r.prototypeSetter!.entries[0]!.metadata.metadata.id;
      for (const self of [
        r.api.singleton0.value,
        r.api.singleton2.value,
        r.api.native3(id + 1, 0),
        r.api.native3(id, 0),
        r.api.native3(id, 1),
      ])
        typeError(() => r.api.lifted3(self, receiver, argv));
      expect(r.api.lifted3(r.api.singleton3.value, receiver, argv)).toBe(r.api.undefinedValue());
      r.api.clearRealm();
      typeError(() => r.api.lifted3(r.api.singleton3.value, receiver, argv));
    });
    it("keeps the intentionally different Object.setPrototypeOf results and errors", () => {
      r.api.initialize();
      const object = r.api.ordinary(0),
        primitive = r.api.boxNumber(-0);
      expect(run(object, [primitive])).toBe(r.api.undefinedValue());
      typeError(() => r.api.algorithm2(null, r.vector([object, primitive])));
      expect(run(primitive, [null], true)).toBe(r.api.undefinedValue());
      expect(r.api.algorithm2(null, r.vector([primitive, null]))).toBe(primitive);
    });
  });

describe("canonical retained prototype setter owner", () => {
  const fixture = () => objectExtensibilityFixture(false, false, "interned", true, true);
  it("coexists with other fixed owners but rejects duplicates, copies, foreign and wrong scopes", () => {
    const r = fixture(),
      pack = r.prototypeSetter!,
      count = r.f.module.functions.length;
    expect(requireNativeObjectPrototypeSetterAlgorithm(r.tx, pack, r.realm.declarations)).toBe(pack);
    expect(() => reserveNativeObjectPrototypeSetterAlgorithm(r.tx, r.algorithmDependencies)).toThrow(/already/);
    expect(r.f.module.functions.length).toBe(count);
    expect(() => requireNativeObjectPrototypeSetterAlgorithm(r.tx, { ...pack }, r.realm.declarations)).toThrow(
      /copied/,
    );
    expect(() =>
      requireNativeObjectPrototypeSetterAlgorithm(r.tx, r.prototypeAlgorithm as any, r.realm.declarations),
    ).toThrow(/wrong-scope/);
    expect(() => requireNativeObjectSetPrototypeAlgorithm(r.tx, pack as any, r.realm.declarations)).toThrow(
      /wrong-scope/,
    );
    const other = fixture();
    expect(() => requireNativeObjectPrototypeSetterAlgorithm(other.tx, pack, r.realm.declarations)).toThrow(/foreign/);
    expect(() => requireNativeObjectPrototypeSetterAlgorithm(r.tx, pack, other.realm.declarations)).toThrow(
      /different expected realm/,
    );
  });
  it("does not certify reservations or fill without completed prerequisites", () => {
    const r = fixture();
    expect(() => requireCompletedNativeObjectPrototypeSetterAlgorithm(r.tx, r.prototypeSetter!)).toThrow(
      /missing canonical/,
    );
    r.tx.freezeReservations();
    expect(() => fillNativeObjectPrototypeSetterAlgorithm(r.tx, r.prototypeSetter!)).toThrow(/canonical|incomplete/);
  });
  it.each(["algorithm", "lifted"] as const)("independently re-derives %s despite valid allocator receipts", (kind) => {
    const r = fixture();
    fillObjectExtensibilityDependencies(r);
    const fill = r.tx.fillFunction.bind(r.tx),
      target = r.prototypeSetter!.entries[0]![kind];
    r.tx.fillFunction = (token, definition) =>
      fill(token, token === target ? { locals: [], body: [{ op: "ref.null.extern" }] } : definition);
    fillNativeObjectPrototypeSetterAlgorithm(r.tx, r.prototypeSetter!);
    r.tx.assertCompletedReservation(target);
    expect(() => requireCompletedNativeObjectPrototypeSetterAlgorithm(r.tx, r.prototypeSetter!)).toThrow(
      /noncanonical function definition/,
    );
  });
  it("does not retry partial fills into authority", () => {
    const r = fixture();
    fillObjectExtensibilityDependencies(r);
    const fill = r.tx.fillFunction.bind(r.tx),
      target = r.prototypeSetter!.entries[0]!.lifted;
    r.tx.fillFunction = (token, definition) => {
      if (token === target) throw Error("partial fill interruption");
      fill(token, definition);
    };
    expect(() => fillNativeObjectPrototypeSetterAlgorithm(r.tx, r.prototypeSetter!)).toThrow(/partial fill/);
    r.tx.fillFunction = fill;
    expect(() => fillNativeObjectPrototypeSetterAlgorithm(r.tx, r.prototypeSetter!)).toThrow(/failed fill/);
    expect(() => requireCompletedNativeObjectPrototypeSetterAlgorithm(r.tx, r.prototypeSetter!)).toThrow(
      /missing canonical/,
    );
  });
});
