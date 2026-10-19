// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import {
  mixedRuntime,
  mixedOwnerFixture,
  reserveMixedOwner,
  fillMixedDependencies,
} from "./helpers/native-mixed-object-access.js";
import {
  reserveNativeMixedObjectAccessResources,
  fillNativeMixedObjectAccessStructure,
  requireCompletedNativeMixedObjectAccessStructure,
  requireCompletedNativeMixedObjectAccess,
} from "../src/backend/wasmgc/resources/native-mixed-object-access.js";
import {
  buildMixedObjectIsExtensible,
  buildMixedObjectPreventExtensions,
} from "../src/runtime/wasmgc/values/mixed-object-access-bodies.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "../src/runtime/wasmgc/values/ordinary-object-descriptor-common.js";

// Synchronous owner audits must yield so the worker can acknowledge completed tests.
afterEach(async () => await setImmediate());

for (const [displaced, decoded] of [
  [false, false],
  [true, false],
  [true, true],
] as const)
  describe(
    decoded
      ? "decoded displaced mixed extensibility / UTF8"
      : displaced
        ? "displaced mixed extensibility / UTF8"
        : "mixed extensibility / UTF16",
    () => {
      let runtime: ReturnType<typeof mixedRuntime>;
      beforeAll(() => {
        runtime = mixedRuntime(displaced, decoded);
      }, 120000);
      const api = () => runtime.api;
      const key = (text: string) => api()["key:" + text].value;
      it("keeps uninitialized realm authority unready", () => {
        expect(api().isExtensible(null)).toBe(2);
        expect(api().preventExtensions(null)).toBe(2);
      });
      const families = [
        "ordinary",
        "Boolean",
        "Number",
        "String",
        "Symbol",
        "BigInt",
        "Object.prototype",
        "native",
      ] as const;
      it.each(families)("prevents new keys on %s without sealing properties or changing parent/identity", (family) => {
        api().initialize();
        const parent = api().ordinary(null);
        const object =
          family === "ordinary"
            ? api().ordinary(parent)
            : family === "Boolean"
              ? api().newBoolean(parent, 1)
              : family === "Number"
                ? api().newNumber(parent, -0)
                : family === "String"
                  ? api().stringCreate(parent, key("😀"))
                  : family === "Symbol"
                    ? api().newSymbol(parent, api().symbol(81))
                    : // Payload storage is not a BigInt semantic-admission grant.
                      family === "BigInt"
                      ? api().newBigInt(parent, null)
                      : family === "Object.prototype"
                        ? api().objectPrototype.value
                        : api().native.value;
        api().put(object, key("own"), 42, 7, null);
        const initial = api().readFlags(object),
          prototype = api().getPrototypeOf(object);
        expect(api().isExtensible(object)).toBe(1);
        expect(api().readFlags(object)).toBe(initial);
        expect(api().preventExtensions(object)).toBe(1);
        expect(api().isExtensible(object)).toBe(0);
        expect(api().readFlags(object)).toBe(initial | flags.nonExtensible);
        expect(api().getPrototypeOf(object)[0]).toBe(prototype[0]);
        expect(Object.is(api().getPrototypeOf(object)[1], prototype[1])).toBe(true);
        expect(api().setPrototypeOf(object, prototype[1])).toBe(1);
        expect(api().setPrototypeOf(object, api().ordinary(null))).toBe(0);
        expect(api().ownFlags(object, key("own"))).toEqual([1, 7]);
        api().insertOnly(object, key("own"), 73);
        expect(api().get(object, key("own"), object)).toEqual([1, 73]);
        const missing = api().ownFlags(object, key("absent"));
        api().insertOnly(object, key("absent"), 99);
        expect(api().ownFlags(object, key("absent"))).toEqual(missing);
        expect(missing[1]).toBe(-1);
        expect(api().preventExtensions(object)).toBe(1);
        expect(api().readFlags(object)).toBe(initial | flags.nonExtensible);
        expect(api().calls.value).toBe(0);
        expect(WebAssembly.Module.imports(runtime.wasm)).toEqual([]);
      });
      it("preserves all unrelated flag bits and reads only own state, not cyclic/foreign parents", () => {
        api().initialize();
        const object = api().ordinary({ foreignParent: true });
        api().flags(object, 0x5a5a5a80);
        expect(api().isExtensible(object)).toBe(1);
        expect(api().preventExtensions(object)).toBe(1);
        expect(api().readFlags(object)).toBe(0x5a5a5a81);
        api().corruptParent(object, object);
        expect(api().isExtensible(object)).toBe(0);
        expect(api().preventExtensions(object)).toBe(1);
        expect(Object.is(api().getPrototypeOf(object)[1], object)).toBe(true);
      });
      it("does not freeze String virtual descriptors or call getters", () => {
        api().initialize();
        const object = api().stringCreate(null, key("😀"));
        api().put(object, key("own"), null, 8, key("throw"));
        const high = api().get(object, key("0"), object)[1];
        expect(api().preventExtensions(object)).toBe(1);
        expect(api().ownFlags(object, key("0"))).toEqual([1, 2]);
        expect(api().ownFlags(object, key("length"))).toEqual([1, 0]);
        expect(api().codeUnit(api().get(object, key("0"), object)[1], 0)).toBe(api().codeUnit(high, 0));
        expect(api().ownFlags(object, key("own"))).toEqual([1, 8]);
        expect(api().calls.value).toBe(0);
      });
      it("distinguishes unready source/realm/bags from unsupported foreign/primitive/metadata values", () => {
        api().initialize();
        for (const value of [api().makeEmpty(), api().makeCaptured(10)]) {
          expect(api().isExtensible(value)).toBe(2);
          expect(api().preventExtensions(value)).toBe(2);
        }
        let getters = 0;
        const foreign = {
          get arbitrary() {
            getters++;
            return 1;
          },
        };
        const op = api().objectPrototype.value;
        for (const value of [
          null,
          undefined,
          7,
          false,
          "host",
          1n,
          Symbol(),
          foreign,
          api().foreign(null),
          api().unknownSource(),
          api().nativeClone(runtime.metadataId, 0, op),
        ]) {
          expect(api().isExtensible(value)).toBe(3);
          expect(api().preventExtensions(value)).toBe(3);
        }
        expect(getters).toBe(0);
        const native = api().native.value;
        for (const invalid of [
          api().nativeClone(runtime.metadataId + 1, 0, op),
          api().nativeClone(runtime.metadataId, 1, op),
          api().wrongLift(),
        ]) {
          api().native.value = invalid;
          expect(api().isExtensible(invalid)).toBe(3);
          expect(api().preventExtensions(invalid)).toBe(3);
          expect(api().readFlags(invalid)).toBe(flags.nullPrototype);
        }
        api().native.value = native;
        api().clearBag(native);
        expect(api().isExtensible(native)).toBe(2);
        expect(api().preventExtensions(native)).toBe(2);
        api().setBag(native, foreign);
        expect(api().isExtensible(native)).toBe(3);
        expect(api().preventExtensions(native)).toBe(3);
      });
    },
  );

describe("canonical mixed extensibility owner", () => {
  for (const role of ["isExtensible", "preventExtensions"] as const) {
    it("rejects a substituted " + role + " declaration before reservation", () => {
      const r = mixedOwnerFixture();
      const row = r.plan.declarations.find((entry) => entry.key.endsWith(":" + role))!;
      (row as { name: string }).name = "lookalike";
      const before = r.f.module.functions.length;
      expect(() => reserveNativeMixedObjectAccessResources(r.tx, "mixed:access", r.dependencies, r.plan)).toThrow(
        /substituted declaration/,
      );
      expect(r.f.module.functions.length).toBe(before);
    });
    it("checks the canonical " + role + " body, not just completion counters", () => {
      const r = mixedOwnerFixture(),
        pack = reserveMixedOwner(r);
      r.tx.freezeReservations();
      fillMixedDependencies(r);
      const fill = r.tx.fillFunction.bind(r.tx);
      r.tx.fillFunction = (token, definition) =>
        fill(token, token === pack[role] ? { locals: [], body: [{ op: "i32.const", value: 1 }] } : definition);
      fillNativeMixedObjectAccessStructure(r.tx, pack);
      expect(() => requireCompletedNativeMixedObjectAccessStructure(r.tx, pack)).toThrow(
        "noncanonical structural body " + role,
      );
      expect(() => requireCompletedNativeMixedObjectAccess(r.tx, pack)).toThrow(/remain unavailable/);
    });
  }
  it.each([buildMixedObjectIsExtensible, buildMixedObjectPreventExtensions])(
    "rejects non-data pure operands without invoking accessors",
    (builder) => {
      let calls = 0;
      const input = {
        get realm() {
          calls++;
          return 0;
        },
      };
      expect(() => builder(input as never)).toThrow(/accessor/);
      expect(calls).toBe(0);
    },
  );
});
