// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  mixedRuntime,
  mixedOwnerFixture,
  reserveMixedOwner,
  fillMixedDependencies,
  alternativeMixedStringOwner,
} from "./helpers/native-mixed-object-access.js";
import {
  reserveNativeMixedObjectAccessResources,
  requireNativeMixedObjectAccessReservations,
  fillNativeMixedObjectAccessStructure,
  requireCompletedNativeMixedObjectAccessStructure,
  requireCompletedNativeMixedObjectAccess,
  nativeMixedObjectAccessReservationInventory,
} from "../src/backend/wasmgc/resources/native-mixed-object-access.js";
import {
  buildMixedObjectClassify,
  buildMixedObjectGet,
  buildMixedObjectLookup,
} from "../src/runtime/wasmgc/values/mixed-object-access-bodies.js";
import { publicRealmDeclarations } from "./helpers/native-object-realm.js";

afterEach(async () => {
  await setImmediate();
});
for (const displaced of [false, true])
  describe(displaced ? "displaced coordinates and actual UTF8 keys" : "normal coordinates and UTF16 keys", () => {
    let runtime: ReturnType<typeof mixedRuntime>;
    beforeAll(() => {
      runtime = mixedRuntime(displaced);
    }, 120000);
    const api = () => runtime.api;
    const key = (text: string) => api()["key:" + text].value;
    const reset = () => {
      api().initialize();
      api().calls.value = 0;
    };
    it("executes a nonempty zero-import component, with pending production/source authority", () => {
      expect(WebAssembly.Module.imports(runtime.wasm)).toEqual([]);
      expect(WebAssembly.Module.exports(runtime.wasm).length).toBeGreaterThan(25);
      expect(api().isUtf8(key("own"))).toBe(displaced ? 1 : 0);
      expect(api().has(null, key("own"))).toBe(2);
      reset();
      const captured = api().makeCaptured(100),
        empty = api().makeEmpty();
      expect(api().callCaptured(captured, 12)).toBe(112);
      expect(api().callCaptured(empty, 12)).toBe(19);
      expect(api().has(captured, key("own"))).toBe(2);
      expect(api().getPrototypeOf(captured)[0]).toBe(2);
      expect(api().get(empty, key("length"), empty)[0]).toBe(2);
      expect(api().has(api().unknownSource(), key("own"))).toBe(3);
    });
    it("returns a nearer own entry before an unknown parent and ignores storage-prefix prototype", () => {
      reset();
      const a = api().ordinary({ unknown: true }),
        fake = api().ordinary(null);
      api().put(a, key("own"), 42, 7, null);
      api().put(fake, key("absent"), 99, 7, null);
      api().fakePrefix(a, fake);
      expect(api().get(a, key("own"), a)).toEqual([1, 42]);
      expect(api().has(a, key("own"))).toBe(1);
      expect(api().has(a, key("absent"))).toBe(3);
      const zero = api().ordinary(null);
      expect(api().getPrototypeOf(zero)).toEqual([1, null]);
      expect(api().get(zero, key("absent"), zero)[0]).toBe(0);
    });
    it("traverses ordinary/wrapper/String identities and preserves String own-before-virtual precedence", () => {
      reset();
      const parent = api().ordinary(null),
        wrapped = api().newNumber(parent, -0);
      api().put(parent, key("own"), 73, 7, null);
      const string = api().stringCreate(wrapped, key("😀"));
      expect(api().get(string, key("own"), string)).toEqual([1, 73]);
      expect(api().ownFlags(string, key("0"))).toEqual([1, 2]);
      expect(api().ownFlags(string, key("length"))).toEqual([1, 0]);
      const high = api().get(string, key("0"), string),
        low = api().get(string, key("1"), string);
      expect(high[0]).toBe(1);
      expect(low[0]).toBe(1);
      expect(api().codeUnit(high[1], 0)).toBe(0xd83d);
      expect(api().codeUnit(low[1], 0)).toBe(0xde00);
      const length = api().get(string, key("length"), string);
      expect(length[0]).toBe(1);
      expect(api().unbox(length[1])).toBe(2);
      for (const absent of ["2", "01", "-0"]) expect(api().has(string, key(absent))).toBe(0);
      // Deliberately inject an ordinary own entry as a precedence control; this is not a public String define grant.
      api().put(string, key("0"), 91, 7, null);
      expect(api().get(string, key("0"), string)).toEqual([1, 91]);
      expect(api().has(string, key("absent"))).toBe(0);
      const boolean = api().newBoolean(string, 1);
      expect(api().get(boolean, key("own"), boolean)).toEqual([1, 73]);
    });
    it("retains present undefined and getter-less accessor shadowing", () => {
      reset();
      const parent = api().ordinary(null),
        a = api().ordinary(parent),
        u = api().undefined.value;
      api().put(parent, key("own"), 123, 7, null);
      api().put(a, key("own"), u, 7, null);
      const data = api().get(a, key("own"), a);
      expect(data[0]).toBe(1);
      expect(Object.is(data[1], u)).toBe(true);
      const b = api().ordinary(parent);
      api().put(b, key("own"), null, 8, null);
      const accessor = api().get(b, key("own"), b);
      expect(accessor[0]).toBe(1);
      expect(Object.is(accessor[1], u)).toBe(true);
      expect(api().has(b, key("own"))).toBe(1);
      expect(api().calls.value).toBe(0);
      const tombstone = api().ordinary(parent);
      api().put(tombstone, key("own"), 456, 135, null);
      expect(api().get(tombstone, key("own"), tombstone)).toEqual([1, 123]);
    });
    it("uses the original receiver and an actual empty vector in named getter observers", () => {
      reset();
      const parent = api().ordinary(null),
        child = api().ordinary(api().newNumber(parent, 7));
      api().put(parent, key("own"), null, 8, key("own"));
      for (const receiver of [null, undefined, api().undefined.value, 4, "primitive", { receiver: true }]) {
        const result = api().get(child, key("own"), receiver);
        expect(result[0]).toBe(1);
        expect(Object.is(result[1], receiver)).toBe(true);
        expect(Object.is(api().receiver.value, receiver)).toBe(true);
        expect(api().argc.value).toBe(0);
      }
      const calls = api().calls.value;
      expect(api().has(child, key("own"))).toBe(1);
      expect(api().calls.value).toBe(calls);
    });
    it("keeps lookup locals across reentry and propagates exact tag/payload from observer abrupt completion", () => {
      reset();
      const nested = api().ordinary(null),
        parent = api().ordinary(null),
        child = api().ordinary(parent),
        receiver = { outer: true };
      api().put(nested, key("own"), null, 8, key("own"));
      api().nested.value = nested;
      api().put(parent, key("reenter"), null, 8, key("reenter"));
      const result = api().get(child, key("reenter"), receiver);
      expect(result[0]).toBe(1);
      expect(Object.is(result[1], receiver)).toBe(true);
      expect(api().calls.value).toBe(2);
      const payload = { abrupt: true };
      api().payload.value = payload;
      api().put(parent, key("throw"), null, 8, key("throw"));
      let caught: unknown;
      try {
        api().get(child, key("throw"), receiver);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WebAssembly.Exception);
      const exception = caught as WebAssembly.Exception;
      expect(exception.is(api().exception)).toBe(true);
      expect(Object.is(exception.getArg(api().exception, 0), payload)).toBe(true);
      expect(api().get(child, key("reenter"), receiver)[0]).toBe(1);
    });
    it("recognizes only the actual control native singleton and keeps incomplete populations unresolved", () => {
      reset();
      const native = api().native.value,
        op = api().objectPrototype.value;
      expect(api().getPrototypeOf(native)[0]).toBe(1);
      expect(Object.is(api().getPrototypeOf(native)[1], op)).toBe(true);
      expect(api().getPrototypeOf(op)).toEqual([1, null]);
      expect(api().has(native, key("absent"))).toBe(2);
      expect(api().has(op, key("absent"))).toBe(2);
      api().put(native, key("own"), 67, 7, null);
      expect(api().get(native, key("own"), native)).toEqual([1, 67]);
      const clone = api().nativeClone(runtime.metadataId, 0, op);
      api().native.value = clone;
      expect(api().getPrototypeOf(clone)[0]).toBe(1);
      for (const invalid of [
        api().nativeClone(runtime.metadataId + 1, 0, op),
        api().nativeClone(runtime.metadataId, 1, op),
        api().wrongLift(),
      ]) {
        api().native.value = invalid;
        expect(api().getPrototypeOf(invalid)[0]).toBe(3);
      }
      api().native.value = native;
      for (const value of [
        api().nativeClone(runtime.metadataId, 0, op),
        api().nativeClone(runtime.metadataId + 1, 0, op),
        api().nativeClone(runtime.metadataId, 1, op),
        api().foreign(null),
        {},
        4,
        null,
      ])
        expect(api().has(value, key("own"))).toBe(3);
      api().clearBag(native);
      expect(api().has(native, key("own"))).toBe(2);
    });
    it("authenticates keys, and never reads foreign/unready bags as empty", () => {
      reset();
      const a = api().ordinary(null);
      for (const invalidKey of [null, undefined, "host string", {}, 2]) expect(api().has(a, invalidKey)).toBe(3);
      const symbol = api().symbol(42);
      api().put(a, symbol, 21, 7, null);
      expect(api().get(a, symbol, a)).toEqual([1, 21]);
      expect(api().has(a, key("own"))).toBe(0);
      const native = api().native.value;
      api().native.value = {};
      expect(api().has(native, key("own"))).toBe(3);
    });
    it("preserves immutable Object.prototype and checks SameValue before nonextensibility", () => {
      reset();
      const op = api().objectPrototype.value,
        a = api().ordinary(null),
        b = api().ordinary(null);
      expect(api().setPrototypeOf(op, null)).toBe(1);
      expect(api().setPrototypeOf(op, b)).toBe(0);
      expect(api().setPrototypeOf(a, b)).toBe(1);
      api().flags(a, 129);
      expect(api().setPrototypeOf(a, b)).toBe(1);
      expect(api().setPrototypeOf(a, null)).toBe(0);
      expect(Object.is(api().getPrototypeOf(a)[1], b)).toBe(true);
    });
    it("rejects self/indirect/preexisting cycles and unknown edges before mutation", () => {
      reset();
      const a = api().ordinary(null),
        b = api().ordinary(a),
        x = api().ordinary(null),
        y = api().ordinary(x);
      expect(api().setPrototypeOf(a, a)).toBe(0);
      expect(api().setPrototypeOf(a, b)).toBe(0);
      expect(api().setPrototypeOf(a, {})).toBe(3);
      expect(api().getPrototypeOf(a)).toEqual([1, null]);
      api().corruptParent(x, y);
      expect(api().setPrototypeOf(a, x)).toBe(3);
      expect(api().has(x, key("absent"))).toBe(3);
      expect(api().getPrototypeOf(a)).toEqual([1, null]);
      const source = api().makeEmpty();
      expect(api().setPrototypeOf(a, source)).toBe(2);
    });
    it("walks beyond a small fixed depth with no accidental absence or lookahead", () => {
      reset();
      let tail = api().ordinary(null);
      api().put(tail, key("own"), 94, 7, null);
      for (let i = 0; i < 300; i++) tail = api().ordinary(tail);
      expect(api().get(tail, key("own"), tail)).toEqual([1, 94]);
      expect(api().has(tail, key("absent"))).toBe(0);
    });
    it("rejects getter-bearing/hidden/sparse pure operands without invoking callbacks", () => {
      let calls = 0;
      const bad = { ...runtime.operands };
      Object.defineProperty(bad, "realm", {
        enumerable: true,
        get() {
          calls++;
          return 0;
        },
      });
      expect(() => buildMixedObjectClassify(bad)).toThrow(/accessor/);
      expect(calls).toBe(0);
      expect(() => buildMixedObjectLookup({ ...runtime.operands, carriers: Array(3) })).toThrow(/sparse/);
      expect(() =>
        buildMixedObjectGet({
          entryTypeIdx: 0,
          vectorTypeIdx: 0,
          undefinedGlobal: 0,
          lookup: 0,
          newVector: 0,
          call: NaN,
        }),
      ).toThrow(/coordinate/);
    });
  });

describe("genuine mixed structural resource owner", () => {
  it("reserves exact structural and pending Get roles without public completion", () => {
    const r = mixedOwnerFixture(),
      pack = reserveMixedOwner(r),
      inventory = nativeMixedObjectAccessReservationInventory(r.tx, pack);
    expect(inventory.functions.length).toBe(7);
    expect(inventory.structuralFunctions.length).toBe(6);
    expect(inventory.pendingGet).toBe(pack.get);
    expect(() => requireCompletedNativeMixedObjectAccess(r.tx, pack)).toThrow(/mixed Call, source lowering/);
    expect(() => requireNativeMixedObjectAccessReservations(r.tx, { ...pack })).toThrow(/copied owner/);
    const foreign = mixedOwnerFixture(true);
    expect(() => requireNativeMixedObjectAccessReservations(foreign.tx, pack)).toThrow(/foreign/);
    expect(() => publicRealmDeclarations(r.f, r.c)).toThrow(/population/);
  });
  it("rejects malformed dependency descriptors and genuine alternate owners before allocation", () => {
    const r = mixedOwnerFixture(),
      before = r.f.module.functions.length;
    let called = 0;
    const malformed = { ...r.dependencies };
    Object.defineProperty(malformed, "values", {
      enumerable: true,
      get() {
        called++;
        return r.values;
      },
    });
    expect(() => reserveNativeMixedObjectAccessResources(r.tx, "mixed:access", malformed, r.plan)).toThrow(/accessor/);
    expect(called).toBe(0);
    expect(r.f.module.functions.length).toBe(before);
    const hidden = { ...r.dependencies };
    Object.defineProperty(hidden, "values", { enumerable: false });
    expect(() => reserveNativeMixedObjectAccessResources(r.tx, "mixed:access", hidden, r.plan)).toThrow(/hidden/);
    const foreign = mixedOwnerFixture();
    expect(() =>
      reserveNativeMixedObjectAccessResources(
        r.tx,
        "mixed:access",
        { ...r.dependencies, stringOwn: foreign.own },
        r.plan,
      ),
    ).toThrow(/foreign/);
    expect(r.f.module.functions.length).toBe(before);
    const alternative = alternativeMixedStringOwner(r),
      afterAlternative = r.f.module.functions.length;
    expect(() =>
      reserveNativeMixedObjectAccessResources(
        r.tx,
        "mixed:access",
        { ...r.dependencies, stringOwn: alternative.pack, stringOwnDependencies: alternative.dependencies },
        r.plan,
      ),
    ).toThrow(/different shared state/);
    expect(r.f.module.functions.length).toBe(afterAlternative);
    expect(() => reserveMixedOwner(r)).not.toThrow();
  });
  it("preflights the last key before reserving any mixed role", () => {
    const r = mixedOwnerFixture(),
      last = r.plan.declarations.at(-1)!;
    r.tx.reserveFunction(last.key, "collision", { params: [], results: [] });
    const functions = r.f.module.functions.length,
      types = r.f.module.types.length;
    expect(() => reserveMixedOwner(r)).toThrow(/already|duplicate|reserved/);
    expect(r.f.module.functions.length).toBe(functions);
    expect(r.f.module.types.length).toBe(types);
  });
  it("reauthenticates retained dependency roles and mutable declaration input", () => {
    const r = mixedOwnerFixture(),
      pack = reserveMixedOwner(r),
      values = r.dependencies.values;
    Object.defineProperty(r.dependencies, "values", { value: undefined, enumerable: true });
    expect(() => requireNativeMixedObjectAccessReservations(r.tx, pack)).toThrow();
    Object.defineProperty(r.dependencies, "values", { value: values, enumerable: true });
    expect(() => requireNativeMixedObjectAccessReservations(r.tx, pack)).not.toThrow();
    (r.plan.declarations[0] as { name: string }).name = "changed";
    expect(() => requireNativeMixedObjectAccessReservations(r.tx, pack)).toThrow(/changed declaration/);
  });
  it("requires canonical dependency completion then completes only six structural bodies", () => {
    const r = mixedOwnerFixture(),
      pack = reserveMixedOwner(r);
    r.tx.freezeReservations();
    expect(() => fillNativeMixedObjectAccessStructure(r.tx, pack)).toThrow(/canonical|incomplete|missing/);
    fillMixedDependencies(r);
    fillNativeMixedObjectAccessStructure(r.tx, pack);
    expect(() => requireCompletedNativeMixedObjectAccessStructure(r.tx, pack, r.dependencies)).not.toThrow();
    expect(pack.get.object.body).toEqual([]);
    expect(() => requireCompletedNativeMixedObjectAccess(r.tx, pack)).toThrow(/remain unavailable/);
    expect(() => fillNativeMixedObjectAccessStructure(r.tx, pack)).toThrow(/duplicate/);
  });
  it("refuses a canonical-looking external fill and wrong canonical body completion", () => {
    const r = mixedOwnerFixture(),
      pack = reserveMixedOwner(r);
    r.tx.freezeReservations();
    fillMixedDependencies(r);
    const fill = r.tx.fillFunction.bind(r.tx);
    r.tx.fillFunction = (token, definition) =>
      fill(token, token === pack.has ? { locals: [], body: [{ op: "i32.const", value: 0 }] } : definition);
    fillNativeMixedObjectAccessStructure(r.tx, pack);
    expect(() => requireCompletedNativeMixedObjectAccessStructure(r.tx, pack)).toThrow(
      /noncanonical structural body has/,
    );
    expect(() => requireCompletedNativeMixedObjectAccess(r.tx, pack)).toThrow(/remain unavailable/);
  });
  it("refuses caller-filled roles and post-fill instruction mutation", () => {
    const r = mixedOwnerFixture(),
      pack = reserveMixedOwner(r);
    r.tx.freezeReservations();
    fillMixedDependencies(r);
    r.tx.fillFunction(pack.has, { locals: [], body: [{ op: "i32.const", value: 0 }] });
    expect(() => requireCompletedNativeMixedObjectAccessStructure(r.tx, pack)).toThrow(/missing canonical/);
    expect(() => fillNativeMixedObjectAccessStructure(r.tx, pack)).toThrow(/filled|duplicate/);
    const next = mixedOwnerFixture(),
      p = reserveMixedOwner(next);
    next.tx.freezeReservations();
    fillMixedDependencies(next);
    fillNativeMixedObjectAccessStructure(next.tx, p);
    p.has.object.body = [{ op: "i32.const", value: 0 }];
    expect(() => requireCompletedNativeMixedObjectAccessStructure(next.tx, p)).toThrow(/changed|mutat|drift|alter/);
  });
  it.each([
    "ordinary-own",
    "String-own",
    "equality",
    "flatten-locals",
    "copy-tree-locals",
    "UTF8-decoder-locals",
  ] as const)("rejects a genuine dependency with altered %s before structural fill", (role) => {
    const r = mixedOwnerFixture(role === "UTF8-decoder-locals"),
      pack = reserveMixedOwner(r);
    const target =
      role === "ordinary-own"
        ? r.lookup.findOwn
        : role === "String-own"
          ? r.own.findOwn
          : role === "equality"
            ? r.equality.equals
            : role === "flatten-locals"
              ? r.flatten.flatten
              : role === "copy-tree-locals"
                ? r.flatten.copyTree
                : r.flatten.utf8Decoder!;
    r.tx.freezeReservations();
    const fill = r.tx.fillFunction.bind(r.tx);
    let injected = 0;
    r.tx.fillFunction = (token, definition) => {
      if (token !== target) return fill(token, definition);
      injected++;
      if (role.endsWith("locals"))
        return fill(token, {
          locals: [...definition.locals, { name: "fault-unused-local", type: { kind: "i32" } }],
          body: definition.body,
        });
      return fill(token, {
        locals: [],
        body:
          role === "equality"
            ? [{ op: "i32.const", value: 0 }]
            : [{ op: "ref.null", typeIdx: r.f.objects.propEntry.typeIndex }],
      });
    };
    fillMixedDependencies(r);
    expect(injected).toBe(1);
    expect(() => fillNativeMixedObjectAccessStructure(r.tx, pack)).toThrow(
      "noncanonical executable dependency " + target.key,
    );
    expect(pack.classify.object.body).toEqual([]);
    expect(() => requireCompletedNativeMixedObjectAccessStructure(r.tx, pack)).toThrow(/missing canonical/);
  });
});
