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
  reserveNativeObjectExtensibilityAlgorithms,
  requireNativeObjectExtensibilityAlgorithms,
  fillNativeObjectExtensibilityAlgorithms,
  requireCompletedNativeObjectExtensibilityAlgorithms,
} from "../src/backend/wasmgc/resources/native-object-extensibility.js";
import { requireCompletedNativeObjectRealm } from "../src/backend/wasmgc/resources/native-object-realm.js";
import { ORDINARY_OBJECT_DESCRIPTOR_ENCODING as flags } from "../src/runtime/wasmgc/values/ordinary-object-descriptor-common.js";
import { requireNativeStringLiteral } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { planNativeStringLiteral } from "../src/runtime/wasmgc/values/string-literal-bodies.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations, type GlobalReservation } from "../src/wasm/physical/module-reservations.js";
import type { Instr } from "../src/wasm/model/instructions.js";

afterEach(async () => await setImmediate());
for (const [displaced, decoded, mode] of [
  [false, false, "interned"],
  [true, false, "interned"],
  [true, true, "interned"],
  [false, false, "allocating"],
] as const)
  describe(`actual Object extensibility algorithms displaced=${displaced} decoded=${decoded} boxes=${mode}`, () => {
    let r: ReturnType<typeof objectExtensibilityRuntime>;
    beforeAll(() => {
      r = objectExtensibilityRuntime(displaced, decoded, mode);
      console.info(
        "Object extensibility component",
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
    const run = (prevent: boolean, values: readonly unknown[], stored = false) => {
      const index = prevent ? 1 : 0,
        self = r.api["singleton" + index].value;
      return stored
        ? r.api["stored" + index](self, null, r.vector(values))
        : r.api["algorithm" + index](null, r.vector(values));
    };
    const bool = (value: unknown) => r.api.readBoolean(value);
    it("executes actual owned slots with zero imports without filling the remaining catalog", () => {
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      expect(r.wholeRealmCompleted).toBe(false);
      expect(r.r.tx.state).toBe("filling");
      expect(r.r.algorithms.entries.map((entry) => entry.request.intrinsic.id)).toEqual([
        "%Object.isExtensible%",
        "%Object.preventExtensions%",
      ]);
      expect(() => requireCompletedNativeObjectRealm(r.r.tx, r.r.realm.declarations)).toThrow(/incomplete/);
      expect(requireCompletedNativeObjectExtensibilityAlgorithms(r.r.tx, r.r.algorithms)).toBe(r.r.algorithms);
    });
    it("handles missing arguments and canonical undefined before realm population", () => {
      expect(bool(run(false, []))).toBe(0);
      expect(run(true, [])).toBe(r.api.undefinedValue());
      expect(bool(run(false, [r.api.undefinedValue()]))).toBe(0);
      expect(run(true, [r.api.undefinedValue()])).toBe(r.api.undefinedValue());
    });
    it("returns false and preserves each native primitive's exact identity, including wide BigInt and signed zero", () => {
      r.api.initialize();
      const primitives = {
        null: null,
        undefined: r.api.undefinedValue(),
        positiveZero: r.api.boxNumber(0),
        negativeZero: r.api.boxNumber(-0),
        smallInteger: r.api.boxNumber(42),
        negativeInteger: r.api.boxNumber(-42),
        minimumI31: r.api.boxNumber(-(2 ** 30)),
        maximumI31: r.api.boxNumber(2 ** 30 - 1),
        outsideI31: r.api.boxNumber(2 ** 30),
        fractional: r.api.boxNumber(0.5),
        subnormal: r.api.boxNumber(Number.MIN_VALUE),
        nan: r.api.boxNumber(NaN),
        infinity: r.api.boxNumber(Infinity),
        false: r.api.boxBoolean(0),
        true: r.api.boxBoolean(1),
        string: r.api.text(),
        symbol: r.api.symbol(82),
        bigintZero: r.api.zero(),
        bigintNegative: r.api.negative(),
        bigintWide: r.api.wide96high(),
      };
      for (const [name, value] of Object.entries(primitives)) {
        try {
          expect(bool(run(false, [value]))).toBe(0);
          expect(Object.is(run(true, [value]), value)).toBe(true);
          expect(bool(run(false, [value], true))).toBe(0);
          expect(Object.is(run(true, [value], true), value)).toBe(true);
        } catch (error) {
          throw new Error("native primitive case " + name, { cause: error });
        }
      }
    });
    it("observes the native i31 conversion without granting host-object authority", () => {
      const native = r.api.boxNumber(7);
      const observation = { type: typeof native, sameAsRaw: Object.is(native, 7), rawPrimitive: r.api.isPrimitive(7) };
      console.info("native i31 conversion", JSON.stringify(observation));
      expect(observation.rawPrimitive).toBe(1);
      expect(bool(run(false, [7]))).toBe(0);
      expect(run(true, [7])).toBe(7);
      expect(r.api.isPrimitive(new Number(7))).toBe(0);
    });
    it("prevents extensions without sealing properties or modifying other flags and preserves the input reference", () => {
      r.api.initialize();
      const object = r.api.ordinary(0);
      r.api.setFlags(object, 0x5a5a5a80);
      expect(bool(run(false, [object]))).toBe(1);
      expect(run(true, [object])).toBe(object);
      expect(bool(run(false, [object]))).toBe(0);
      expect(r.api.flags(object)).toBe(0x5a5a5a81);
      expect(r.api.flags(object) & flags.nonExtensible).toBe(flags.nonExtensible);
      expect(run(true, [object], true)).toBe(object);
      expect(r.api.flags(object)).toBe(0x5a5a5a81);
    });
    it("uses own bags for every wrapper, Object.prototype and genuine native singleton", () => {
      r.api.initialize();
      const objects = [
        r.api.newBoolean(null, 1),
        r.api.newNumber(null, 42),
        r.api.newString(null, r.api.text()),
        r.api.newSymbol(null, r.api.symbol(82)),
        r.api.newBigInt(null, r.api.wide64()),
        r.api.objectPrototype.value,
        r.api.singleton0.value,
      ];
      for (const object of objects) {
        expect(bool(run(false, [object], true))).toBe(1);
        expect(run(true, [object], true)).toBe(object);
        expect(bool(run(false, [object], true))).toBe(0);
        expect(run(true, [object], true)).toBe(object);
      }
    });
    it("does not inspect receivers or ignored extra arguments, even after vector growth", () => {
      r.api.initialize();
      let reads = 0;
      const ignored = new Proxy(
        {},
        {
          get() {
            reads++;
            throw Error("ignored value inspected");
          },
        },
      );
      const primitive = r.api.boxNumber(-0),
        argv = r.vector([primitive, ...Array(102).fill(ignored)]);
      expect(bool(r.api.algorithm0(ignored, argv))).toBe(0);
      expect(r.api.algorithm1(ignored, argv)).toBe(primitive);
      expect(reads).toBe(0);
    });
    it("refuses foreign, unready, stale and layout-only values instead of reporting false or success", () => {
      r.api.initialize();
      let reads = 0;
      const foreign = new Proxy(
        {},
        {
          get() {
            reads++;
            return 7;
          },
        },
      );
      for (const value of [
        undefined,
        // Small integers share the existing i31 Number representation on this
        // engine, as the separate positive conversion control demonstrates.
        false,
        "host",
        Symbol(),
        1n,
        foreign,
        r.api.ordinary(1),
        r.api.source(),
        r.api.undefinedCopy(),
        r.api.native(r.r.algorithms.entries[0]!.metadata.metadata.id, 0),
      ]) {
        expect(() => run(false, [value])).toThrow(WebAssembly.RuntimeError);
        expect(() => run(true, [value])).toThrow(WebAssembly.RuntimeError);
      }
      const native = r.api.singleton0.value;
      r.api.clearBag(native);
      expect(() => run(false, [native])).toThrow(WebAssembly.RuntimeError);
      expect(() => run(true, [native])).toThrow(WebAssembly.RuntimeError);
      const object = r.api.ordinary(0),
        before = r.api.flags(object);
      r.api.clearRealm();
      expect(() => run(false, [object])).toThrow(WebAssembly.RuntimeError);
      expect(() => run(true, [object])).toThrow(WebAssembly.RuntimeError);
      expect(r.api.flags(object)).toBe(before);
      expect(reads).toBe(0);
    });
    it("authenticates actual lifted self identity and propagates the genuine public TypeError tag", () => {
      r.api.initialize();
      const argv = r.vector([]);
      for (const index of [0, 1])
        for (const self of [
          r.api.singleton0.value,
          r.api.singleton1.value,
          r.api.native(r.r.algorithms.entries[0]!.metadata.metadata.id + 1, 0),
        ]) {
          if (self === r.api["singleton" + index].value) continue;
          let error: any;
          try {
            r.api["lifted" + index](self, null, argv);
          } catch (caught) {
            error = caught;
          }
          expect(error).toBeInstanceOf(WebAssembly.Exception);
          expect(error.is(r.api.exception)).toBe(true);
          expect(r.api.errorTag(error.getArg(r.api.exception, 0))).toBe(-11);
        }
      expect(bool(r.api.lifted0(r.api.singleton0.value, null, argv))).toBe(0);
    });
    it("throws a real native TypeError when prevention receives an actual internal false result", () => {
      r.api.initialize();
      const object = r.api.ordinary(0);
      expect(run(true, [object])).toBe(object);
      let error: any;
      try {
        r.api.preventionFalseControl(null, r.vector([object]));
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(WebAssembly.Exception);
      expect(error.is(r.api.exception)).toBe(true);
      expect(r.api.errorTag(error.getArg(r.api.exception, 0))).toBe(-11);
    });
  });

describe("canonical Object extensibility producer", () => {
  it("borrows only the actual two algorithm/lifted slots and rejects duplicate/copy/foreign owners", () => {
    const r = objectExtensibilityFixture(),
      count = r.f.module.functions.length;
    expect(requireNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms, r.realm.declarations)).toBe(r.algorithms);
    expect(() => reserveNativeObjectExtensibilityAlgorithms(r.tx, r.algorithmDependencies)).toThrow(/already/);
    expect(r.f.module.functions.length).toBe(count);
    expect(() => requireNativeObjectExtensibilityAlgorithms(r.tx, { ...r.algorithms }, r.realm.declarations)).toThrow(
      /copied/,
    );
    const other = objectExtensibilityFixture();
    expect(() => requireNativeObjectExtensibilityAlgorithms(other.tx, r.algorithms, r.realm.declarations)).toThrow(
      /foreign/,
    );
    expect(() => requireNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms, other.realm.declarations)).toThrow(
      /different expected realm/,
    );
  });
  it("never evaluates accessor dependencies during authentication", () => {
    const r = objectExtensibilityFixture();
    let reads = 0;
    const input = { ...r.algorithmDependencies };
    Object.defineProperty(input, "mixed", {
      enumerable: true,
      get() {
        reads++;
        return r.mixed;
      },
    });
    expect(() => reserveNativeObjectExtensibilityAlgorithms(r.tx, input)).toThrow(/data/);
    expect(reads).toBe(0);
  });
  it("does not treat reserved slots or missing dependencies as canonical completion", () => {
    const r = objectExtensibilityFixture();
    expect(() => requireCompletedNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(/missing canonical/);
    r.tx.freezeReservations();
    expect(() => fillNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(/canonical|incomplete/);
  });
  it.each([0, 1])("re-derives algorithm %s independently of valid allocator fill receipts", (index) => {
    const r = objectExtensibilityFixture();
    fillObjectExtensibilityDependencies(r);
    const fill = r.tx.fillFunction.bind(r.tx),
      target = r.algorithms.entries[index]!.algorithm;
    r.tx.fillFunction = (token, definition) =>
      fill(token, token === target ? { locals: [], body: [{ op: "ref.null.extern" }] } : definition);
    fillNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms);
    r.tx.assertCompletedReservation(target);
    expect(() => requireCompletedNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(
      /noncanonical function definition/,
    );
  });
  it("re-derives the guarded lifted entry rather than trusting its fill receipt", () => {
    const r = objectExtensibilityFixture();
    fillObjectExtensibilityDependencies(r);
    const fill = r.tx.fillFunction.bind(r.tx),
      target = r.algorithms.entries[0]!.lifted;
    r.tx.fillFunction = (token, definition) =>
      fill(token, token === target ? { locals: [], body: [{ op: "ref.null.extern" }] } : definition);
    fillNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms);
    r.tx.assertCompletedReservation(target);
    expect(() => requireCompletedNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(
      /noncanonical function definition/,
    );
  });
  it("does not retry a partially failed fill into authority", () => {
    const r = objectExtensibilityFixture();
    fillObjectExtensibilityDependencies(r);
    const fill = r.tx.fillFunction.bind(r.tx),
      target = r.algorithms.entries[0]!.lifted;
    r.tx.fillFunction = (token, definition) => {
      if (token === target) throw Error("partial fill interruption");
      fill(token, definition);
    };
    expect(() => fillNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(/partial fill/);
    r.tx.fillFunction = fill;
    expect(() => fillNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(/failed fill/);
    expect(() => requireCompletedNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(/missing canonical/);
  });
  it("audits the actually executed Boolean producer before any algorithm slot is filled", () => {
    const r = objectExtensibilityFixture(),
      fill = r.tx.fillFunction.bind(r.tx);
    r.tx.fillFunction = (token, definition) =>
      fill(token, token === r.booleanBoxes.boxBoolean ? { locals: [], body: [{ op: "ref.null.extern" }] } : definition);
    fillObjectExtensibilityDependencies(r);
    expect(() => fillNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(
      /noncanonical function definition/,
    );
    expect(r.algorithms.entries.every((entry) => entry.algorithm.object.body.length === 0)).toBe(true);
  });
  it.each(["Number", "Boolean", "BigInt"] as const)(
    "audits the executed %s predicate before classifier/catalog filling",
    (kind) => {
      const r = objectExtensibilityFixture(),
        fill = r.tx.fillFunction.bind(r.tx);
      const target =
        kind === "Number"
          ? r.values.functions.isNumber
          : kind === "Boolean"
            ? r.booleans.isBoolean
            : r.bigints.isBigInt;
      r.tx.fillFunction = (token, definition) =>
        fill(token, token === target ? { locals: [], body: [{ op: "i32.const", value: 0 }] } : definition);
      expect(() => fillObjectExtensibilityDependencies(r)).toThrow(/noncanonical function definition/);
      expect(r.algorithms.entries.every((entry) => entry.algorithm.object.body.length === 0)).toBe(true);
    },
  );
  it("rejects a receipt-valid substituted native TypeError constructor", () => {
    const r = objectExtensibilityFixture(),
      fill = r.tx.fillFunction.bind(r.tx);
    r.tx.fillFunction = (token, definition) =>
      fill(token, token === r.errors.newTypeError ? { locals: [], body: [{ op: "ref.null.extern" }] } : definition);
    fillObjectExtensibilityDependencies(r);
    expect(() => fillNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(
      /noncanonical function definition/,
    );
    expect(r.algorithms.entries.every((entry) => entry.lifted.object.body.length === 0)).toBe(true);
  });
  it("rejects receipt-valid substituted Boolean singleton initializers", () => {
    const r = objectExtensibilityFixture(),
      fill = r.tx.fillGlobal.bind(r.tx);
    r.tx.fillGlobal = (token, init) =>
      fill(
        token,
        token === r.booleanBoxes.globals[1]
          ? [
              { op: "i32.const", value: 1 },
              { op: "struct.new", typeIdx: r.values.types.boxedBoolean.typeIndex },
            ]
          : init,
      );
    fillObjectExtensibilityDependencies(r);
    expect(() => fillNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(
      /noncanonical global initializer/,
    );
  });
  it("rejects a receipt-valid substituted canonical undefined initializer", () => {
    const r = objectExtensibilityFixture(),
      fill = r.tx.fillGlobal.bind(r.tx);
    r.tx.fillGlobal = (token, init) =>
      fill(token, token === r.values.globals.undefined ? [{ op: "i32.const", value: 2 }, ...init.slice(1)] : init);
    fillObjectExtensibilityDependencies(r);
    expect(() => fillNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(
      /noncanonical global initializer/,
    );
  });
  it("rejects a receipt-valid substituted TypeError name/message literal", () => {
    const r = objectExtensibilityFixture(),
      fill = r.tx.fillGlobal.bind(r.tx);
    const name = requireNativeStringLiteral(r.tx, r.f.strings, "TypeError");
    const wrong = planNativeStringLiteral(r.f.strings.layout, false, "wrong", "wtf16");
    if (name.kind !== "global" || wrong.kind !== "global") throw Error("lost canonical literal test prerequisites");
    r.tx.fillGlobal = (token, init) => fill(token, token === name.global ? wrong.init : init);
    fillObjectExtensibilityDependencies(r);
    expect(() => fillNativeObjectExtensibilityAlgorithms(r.tx, r.algorithms)).toThrow(
      /noncanonical global initializer/,
    );
  });
});

describe("independent canonical global initializer comparison", () => {
  for (const value of [0, -0, NaN, Infinity, -Infinity])
    it("accepts exact scalar bits for " + (Object.is(value, -0) ? "negative zero" : String(value)), () => {
      const tx = new PhysicalModuleReservations(createEmptyModule());
      const global = tx.reserveGlobal("canonical:global", "canonicalGlobal", { kind: "f64" }, false);
      tx.freezeReservations();
      tx.fillGlobal(global, [{ op: "f64.const", value }]);
      expect(() => tx.assertCanonicalGlobalInitializer(global, [{ op: "f64.const", value }])).not.toThrow();
    });
  it("refuses a valid fill receipt with the wrong signed-zero initializer", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const global = tx.reserveGlobal("canonical:global", "canonicalGlobal", { kind: "f64" }, false);
    tx.freezeReservations();
    tx.fillGlobal(global, [{ op: "f64.const", value: -0 }]);
    tx.assertCompletedReservation(global);
    expect(() => tx.assertCanonicalGlobalInitializer(global, [{ op: "f64.const", value: 0 }])).toThrow(
      /noncanonical global initializer/,
    );
  });
  it("refuses different NaN payload bits despite Object.is equality", () => {
    const fromBits = (bits: bigint) => {
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, bits, true);
      return view.getFloat64(0, true);
    };
    const a = fromBits(0x7ff8000000000001n),
      b = fromBits(0x7ff8000000000002n);
    expect(Object.is(a, b)).toBe(true);
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const global = tx.reserveGlobal("canonical:global", "canonicalGlobal", { kind: "f64" }, false);
    tx.freezeReservations();
    tx.fillGlobal(global, [{ op: "f64.const", value: a }]);
    expect(() => tx.assertCanonicalGlobalInitializer(global, [{ op: "f64.const", value: b }])).toThrow(
      /noncanonical global initializer/,
    );
  });
  it("does not mistake a completed function for a global when malformed expected fields are undefined", () => {
    const tx = new PhysicalModuleReservations(createEmptyModule());
    const fn = tx.reserveFunction("canonical:function", "canonicalFunction", { params: [], results: [] });
    tx.freezeReservations();
    tx.fillFunction(fn, { locals: [], body: [] });
    expect(() =>
      tx.assertCanonicalGlobalInitializer(fn as unknown as GlobalReservation, undefined as unknown as Instr[]),
    ).toThrow(/canonical initializer requires a defined global/);
  });
});
