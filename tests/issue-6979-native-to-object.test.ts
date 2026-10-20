// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  objectExtensibilityFixture,
  objectExtensibilityRuntimeAsync,
  fillObjectExtensibilityDependencies,
} from "./helpers/native-object-extensibility.js";
import { fillNativePrimitivePrototypeIdentities } from "../src/backend/wasmgc/resources/native-primitive-prototype-identities.js";
import {
  reserveNativeToObjectKernel,
  requireNativeToObjectKernel,
  fillNativeToObjectKernel,
  requireCompletedNativeToObjectKernel,
} from "../src/backend/wasmgc/resources/native-to-object.js";
import { requireCompletedNativeObjectRealm } from "../src/backend/wasmgc/resources/native-object-realm.js";
import { NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES } from "../src/runtime/contracts/native-primitive-prototype-identities.js";

afterEach(async () => await setImmediate());
for (const [displaced, decoded, mode] of [
  [false, false, "interned"],
  [true, true, "allocating"],
] as const)
  describe(`actual native ToObject displaced=${displaced} decoded=${decoded} boxes=${mode}`, () => {
    let r: Awaited<ReturnType<typeof objectExtensibilityRuntimeAsync>>;
    beforeAll(async () => {
      r = await objectExtensibilityRuntimeAsync(displaced, decoded, mode, false, false, true, true);
      console.info(
        "native ToObject component",
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
    beforeEach(() => r.api.initialize());
    const prototypeOf = (object: unknown) => {
      const [status, value] = r.api.getPrototypeOf(object);
      expect(status).toBe(1);
      return value;
    };
    const same = (left: unknown, right: unknown) => expect(Object.is(left, right)).toBe(true);
    const typeError = (value: unknown) => {
      let error: any;
      try {
        r.api.toObject(value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(WebAssembly.Exception);
      expect(error.is(r.api.exception)).toBe(true);
      expect(r.api.errorTag(error.getArg(r.api.exception, 0))).toBe(-11);
    };
    it("executes nine genuine owned functions without imports or full realm/provider completion", () => {
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.r.toObject!.completionScope).toBe("native-to-object-wrapping-kernel");
      expect(r.r.tx.state).toBe("filling");
      expect(r.wholeRealmCompleted).toBe(false);
      expect(r.liveNames.filter((name) => name.startsWith("__native_to_object_"))).toHaveLength(9);
      same(requireCompletedNativeToObjectKernel(r.r.tx, r.r.toObject!, r.r.toObjectDependencies!), r.r.toObject);
      expect(() => requireCompletedNativeObjectRealm(r.r.tx, r.r.realm.declarations)).toThrow(/incomplete/);
    });
    it("throws the actual tagged native TypeError for nullish values before prototype or realm lookup", () => {
      for (const value of [null, r.api.undefinedValue()]) typeError(value);
      r.api.clearRealm();
      for (const value of [null, r.api.undefinedValue()]) typeError(value);
    });
    it("refuses copied and foreign undefined carriers rather than treating a tag as canonical identity", () => {
      const other = new WebAssembly.Instance(r.wasm).exports as Record<string, any>;
      for (const value of [r.api.undefinedCopy(), other.undefinedValue(), undefined])
        expect(() => r.api.toObject(value)).toThrow(WebAssembly.RuntimeError);
      typeError(r.api.undefinedValue());
    });
    it.each([0, -0, NaN, Infinity, -Infinity, 42, 0.5, -(2 ** 30), 2 ** 30 - 1, 2 ** 30, 2 ** 53 - 1])(
      "wraps native Number %s freshly, preserving its exact f64 value and intrinsic prototype",
      (value) => {
        r.api.initializePrimitivePrototypes();
        const payload = r.api.boxNumber(value),
          first = r.api.toObject(payload),
          second = r.api.toObject(payload);
        expect(Object.is(first, second)).toBe(false);
        for (const wrapper of [first, second]) {
          expect(r.api.payload_Number(wrapper)).toBe(value);
          same(prototypeOf(wrapper), r.api.prototype_Number());
        }
      },
    );
    it.each([0, 1])("wraps native Boolean %s without invoking a public constructor", (value) => {
      r.api.initializePrimitivePrototypes();
      const payload = r.api.boxBoolean(value),
        a = r.api.toObject(payload),
        b = r.api.toObject(payload);
      expect(Object.is(a, b)).toBe(false);
      expect(r.api.payload_Boolean(a)).toBe(value);
      same(prototypeOf(a), r.api.prototype_Boolean());
    });
    it("retains real String payload references and StringCreate length/virtual-index behavior", () => {
      r.api.initializePrimitivePrototypes();
      for (const [payload, length] of [
        [r.api.text(), 4],
        [r.api.payload_String(r.api.prototype_String()), 0],
      ]) {
        const a = r.api.toObject(payload),
          b = r.api.toObject(payload);
        expect(Object.is(a, b)).toBe(false);
        same(r.api.payload_String(a), payload);
        same(prototypeOf(a), r.api.prototype_String());
        expect(r.api.prototypeStringLength(a)).toBe(length);
        expect(r.api.prototypeLengthValue(a)).toBe(length);
        expect(r.api.prototypeLengthFlags(a)).toBe(0);
        expect(r.api.prototypeHasIndexZero(a)).toBe(length ? 1 : 0);
      }
    });
    it("preserves Symbol and arbitrarily wide BigInt payload references in fresh wrappers", () => {
      r.api.initializePrimitivePrototypes();
      for (const [kind, payload] of [
        ["Symbol", r.api.symbol(82)],
        ["BigInt", r.api.zero()],
        ["BigInt", r.api.negative()],
        ["BigInt", r.api.wide64()],
        ["BigInt", r.api.wide96high()],
        ["BigInt", r.api.wideNegative()],
      ]) {
        const a = r.api.toObject(payload),
          b = r.api.toObject(payload);
        expect(Object.is(a, b)).toBe(false);
        same(r.api["payload_" + kind](a), payload);
        same(prototypeOf(a), r.api["prototype_" + kind]());
      }
    });
    it("retains slices, mixed-encoding ropes and lone-surrogate payloads with their virtual UTF16 characters", () => {
      r.api.initializePrimitivePrototypes();
      const text = "é😀\ud800\0";
      for (const [payload, expected] of [
        [r.api.toObjectText(), text],
        [r.api.toObjectSlice(), text],
        [r.api.toObjectRope(r.api.text(), r.api.toObjectText()), "name" + text],
      ] as const) {
        const object = r.api.toObject(payload);
        same(r.api.payload_String(object), payload);
        same(prototypeOf(object), r.api.prototype_String());
        expect(r.api.prototypeLengthValue(object)).toBe(expected.length);
        expect(r.api.prototypeLengthFlags(object)).toBe(0);
        for (let index = 0; index < expected.length; index++)
          expect(r.api.toObjectIndexCodeUnit(object, index)).toBe(expected.charCodeAt(index));
      }
    });
    it("returns admitted objects and callables unchanged without requiring primitive bootstrap", () => {
      for (const object of [
        r.api.objectPrototype.value,
        r.api.ordinary(0),
        r.api.singleton0.value,
        r.api.newBoolean(null, 1),
        r.api.newNumber(null, -0),
        r.api.newString(null, r.api.text()),
        r.api.newSymbol(null, r.api.symbol(82)),
        r.api.newBigInt(null, r.api.wide64()),
      ])
        same(r.api.toObject(object), object);
    });
    it("refuses foreign, counterfeit, unready and hostile private objects without property access or coercion", () => {
      const other = new WebAssembly.Instance(r.wasm).exports as Record<string, any>;
      other.initialize();
      let reads = 0;
      const trap = () => {
        reads++;
        throw Error("observable host access");
      };
      const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
      const revoked = Proxy.revocable(() => {}, {});
      revoked.revoke();
      for (const value of [
        {},
        [],
        () => {},
        hostile,
        revoked.proxy,
        true,
        "native?",
        Symbol(),
        0n,
        other.ordinary(0),
        other.singleton0.value,
        r.api.ordinary(1),
        r.api.source(),
        r.api.native(r.r.algorithms.entries[0]!.metadata.metadata.id, 0),
      ])
        expect(() => r.api.toObject(value)).toThrow(WebAssembly.RuntimeError);
      expect(reads).toBe(0);
    });
    it("refuses primitive allocation without initialized prototypes, then uses the real role", () => {
      const value = r.api.boxNumber(42);
      expect(() => r.api.toObject(value)).toThrow(WebAssembly.RuntimeError);
      r.api.initializePrimitivePrototypes();
      same(prototypeOf(r.api.toObject(value)), r.api.prototype_Number());
    });
    it.each(["renewRealm", "renewObjectPrototype"])(
      "refuses stale factories after %s until genuine reinitialization",
      (change) => {
        r.api.initializePrimitivePrototypes();
        const previous = r.api.prototype_Boolean(),
          value = r.api.boxBoolean(1);
        r.api[change]();
        expect(() => r.api.toObject(value)).toThrow(WebAssembly.RuntimeError);
        r.api.initializePrimitivePrototypes();
        const next = r.api.prototype_Boolean();
        expect(Object.is(previous, next)).toBe(false);
        same(prototypeOf(r.api.toObject(value)), next);
      },
    );
    it("uses the retained intrinsic identity even after its user-visible state is mutated", () => {
      r.api.initializePrimitivePrototypes();
      const prototype = r.api.prototype_Boolean();
      expect(r.api.internalSetPrototypeOf(prototype, null)).toBe(1);
      r.api.setFlags(prototype, 0x5a5a5a80);
      same(prototypeOf(r.api.toObject(r.api.boxBoolean(1))), prototype);
      same(prototypeOf(prototype), null);
      expect(r.api.flags(prototype)).toBe(0x5a5a5a80);
    });
  });

describe("authenticated native ToObject owner", () => {
  const fixture = () => objectExtensibilityFixture(false, false, "interned", false, false, true, true);
  let r: ReturnType<typeof fixture>;
  beforeEach(() => {
    r = fixture();
  }, 120000);
  it("authenticates real inputs but rejects duplicates, copied owners and substituted dependencies", () => {
    const pack = r.toObject!,
      d = r.toObjectDependencies!;
    expect(requireNativeToObjectKernel(r.tx, pack, d)).toBe(pack);
    const count = r.f.module.functions.length;
    expect(() => reserveNativeToObjectKernel(r.tx, d)).toThrow(/already owns/);
    expect(r.f.module.functions.length).toBe(count);
    expect(() => requireNativeToObjectKernel(r.tx, { ...pack }, d)).toThrow(/copied/);
    expect(() => requireNativeToObjectKernel(r.tx, pack, { ...d })).toThrow(/different expected/);
    const other = fixture();
    expect(() => requireNativeToObjectKernel(other.tx, pack, d)).toThrow(/foreign/);
  });
  it("rejects copied classifier plans and accessors without invoking getters or reserving anything", () => {
    const d = r.toObjectDependencies!,
      count = r.f.module.functions.length;
    expect(() => reserveNativeToObjectKernel(r.tx, { ...d, primitivePlan: structuredClone(d.primitivePlan) })).toThrow(
      /plan/,
    );
    let reads = 0;
    const input = { ...d };
    Object.defineProperty(input, "prototypes", {
      enumerable: true,
      get() {
        reads++;
        return d.prototypes;
      },
    });
    expect(() => reserveNativeToObjectKernel(r.tx, input)).toThrow(/own enumerable/);
    expect(reads).toBe(0);
    expect(r.f.module.functions.length).toBe(count);
  });
  it("never certifies reservations or missing completed prerequisites", () => {
    expect(() => requireCompletedNativeToObjectKernel(r.tx, r.toObject!, r.toObjectDependencies!)).toThrow(
      /missing canonical/,
    );
    r.tx.freezeReservations();
    expect(() => fillNativeToObjectKernel(r.tx, r.toObject!)).toThrow(/canonical|incomplete/);
  });
  for (const role of ["unboxNumber", "unboxBoolean", "TypeError"] as const)
    describe(`substituted ${role} dependency`, () => {
      beforeEach(async () => {
        const target =
          role === "unboxNumber"
            ? r.values.functions.unboxNumber
            : role === "unboxBoolean"
              ? r.booleans.unboxBoolean
              : r.errors.newTypeError;
        const fill = r.tx.fillFunction.bind(r.tx);
        r.tx.fillFunction = (token, definition) =>
          fill(token, token === target ? { locals: [], body: [{ op: "unreachable" }] } : definition);
        fillObjectExtensibilityDependencies(r);
        await setImmediate();
        r.tx.assertCompletedReservation(target);
        fillNativePrimitivePrototypeIdentities(r.tx, r.primitivePrototypes!);
        await setImmediate();
      }, 120000);
      it("cannot turn the receipt into ToObject completion", () => {
        expect(() => fillNativeToObjectKernel(r.tx, r.toObject!)).toThrow(/canonical/);
        expect(r.tx.state).toBe("failed");
        expect(() => requireCompletedNativeToObjectKernel(r.tx, r.toObject!, r.toObjectDependencies!)).toThrow(
          /physical index requested in failed/,
        );
      });
    });
  describe("substituted prototype role getter", () => {
    beforeEach(async () => {
      fillObjectExtensibilityDependencies(r);
      await setImmediate();
      const target = r.primitivePrototypes!.read.Boolean,
        fill = r.tx.fillFunction.bind(r.tx);
      r.tx.fillFunction = (token, definition) =>
        fill(token, token === target ? { locals: [], body: [{ op: "unreachable" }] } : definition);
      fillNativePrimitivePrototypeIdentities(r.tx, r.primitivePrototypes!);
      await setImmediate();
      r.tx.assertCompletedReservation(target);
    }, 120000);
    it("cannot make an unaudited intrinsic selector a wrapping factory", () => {
      expect(() => fillNativeToObjectKernel(r.tx, r.toObject!)).toThrow(/noncanonical function definition/);
      expect(r.tx.state).toBe("failed");
      expect(() => requireCompletedNativeToObjectKernel(r.tx, r.toObject!, r.toObjectDependencies!)).toThrow(
        /physical index requested in failed/,
      );
    });
  });
  describe("genuine completed native prerequisites", () => {
    beforeEach(async () => {
      fillObjectExtensibilityDependencies(r);
      await setImmediate();
      fillNativePrimitivePrototypeIdentities(r.tx, r.primitivePrototypes!);
      await setImmediate();
    }, 120000);
    describe("actual completed kernel", () => {
      beforeEach(async () => {
        fillNativeToObjectKernel(r.tx, r.toObject!);
        await setImmediate();
      }, 120000);
      it("completes the actual kernel without completing the whole realm", () => {
        expect(requireCompletedNativeToObjectKernel(r.tx, r.toObject!, r.toObjectDependencies!)).toBe(r.toObject);
        expect(() => fillNativeToObjectKernel(r.tx, r.toObject!)).toThrow(/duplicate/);
        expect(() => requireCompletedNativeObjectRealm(r.tx, r.realm.declarations)).toThrow(/incomplete/);
      });
    });
    for (const role of [
      "is-undefined",
      "is-null",
      "is-string",
      ...NATIVE_PRIMITIVE_PROTOTYPE_IDENTITIES.map((row) => row.kind + ":create"),
      "run",
    ])
      describe(`substituted owned ${role}`, () => {
        beforeEach(async () => {
          const fill = r.tx.fillFunction.bind(r.tx);
          let replaced = 0;
          r.tx.fillFunction = (token, definition) => {
            if (token.key.endsWith(":to-object:" + role)) {
              replaced++;
              fill(token, { locals: [], body: [{ op: "unreachable" }] });
              r.tx.assertCompletedReservation(token);
            } else fill(token, definition);
          };
          fillNativeToObjectKernel(r.tx, r.toObject!);
          await setImmediate();
          expect(replaced).toBe(1);
        }, 120000);
        it("independently rejects the actual receipt-valid definition", () => {
          expect(() => requireCompletedNativeToObjectKernel(r.tx, r.toObject!, r.toObjectDependencies!)).toThrow(
            /noncanonical function definition/,
          );
        });
      });
    it("makes an interrupted partial fill terminal", () => {
      const fill = r.tx.fillFunction.bind(r.tx);
      r.tx.fillFunction = (token, definition) => {
        if (token.key.endsWith(":to-object:Boolean:create")) throw Error("partial fill interruption");
        fill(token, definition);
      };
      expect(() => fillNativeToObjectKernel(r.tx, r.toObject!)).toThrow(/partial fill/);
      r.tx.fillFunction = fill;
      expect(() => fillNativeToObjectKernel(r.tx, r.toObject!)).toThrow(/failed fill/);
      expect(() => requireCompletedNativeToObjectKernel(r.tx, r.toObject!, r.toObjectDependencies!)).toThrow(
        /missing canonical/,
      );
    });
  });
});
