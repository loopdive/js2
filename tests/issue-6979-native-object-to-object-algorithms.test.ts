// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  objectExtensibilityFixture,
  objectExtensibilityRuntimeAsync,
  objectExtensibilityRuntimeSteps,
  fillObjectExtensibilityDependencies,
} from "./helpers/native-object-extensibility.js";
import {
  reserveNativeObjectToObjectAlgorithms,
  requireNativeObjectToObjectAlgorithms,
  fillNativeObjectToObjectAlgorithms,
  requireCompletedNativeObjectToObjectAlgorithms,
} from "../src/backend/wasmgc/resources/native-object-to-object-algorithms.js";
import { fillNativePrimitivePrototypeIdentities } from "../src/backend/wasmgc/resources/native-primitive-prototype-identities.js";
import { fillNativeToObjectKernel } from "../src/backend/wasmgc/resources/native-to-object.js";
import { requireCompletedNativeObjectRealm } from "../src/backend/wasmgc/resources/native-object-realm.js";
import {
  requireNativeStringLiteral,
  nativeStringLiteralReservationInventory,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import { planNativeStringLiteral } from "../src/runtime/wasmgc/values/string-literal-bodies.js";
import { buildBooleanBoxInitializer } from "../src/runtime/wasmgc/values/boolean-bodies.js";

afterEach(async () => await setImmediate());
for (const [displaced, decoded, mode] of [
  [false, false, "interned"],
  [true, true, "allocating"],
] as const)
  describe(`native ToObject catalog displaced=${displaced} decoded=${decoded} boxes=${mode}`, () => {
    let r: Awaited<ReturnType<typeof objectExtensibilityRuntimeAsync>>;
    // Creating this lazy iterator does no work; every next() runs in a hook.
    const preparation = objectExtensibilityRuntimeSteps(displaced, decoded, mode, false, false, true, true, true);
    const synchronousPhaseMs: number[] = [];
    const phases = [
      "reserve fixture and controls",
      "fill native dependencies",
      "fill extensibility owners",
      "optional static prototype owner",
      "optional retained setter owner",
      "fill primitive prototype identities",
      "audit primitive prototype identities",
      "fill ToObject kernel",
      "audit ToObject kernel",
      "fill catalog algorithm and Call slots",
      "audit catalog algorithm and Call slots",
      "fill controls and establish exports",
      "check reachability and sweep clone",
      "emit and instantiate native component",
    ] as const;
    // This larger component has more real audits than the older fixtures. Each
    // actual phase has a bounded hook, with an exact completion floor; no old
    // deadline, production check, reachable body or test assertion is skipped.
    for (const [index, phase] of phases.entries())
      beforeAll(async () => {
        const start = performance.now(),
          step = preparation.next();
        synchronousPhaseMs.push(performance.now() - start);
        expect(step.done, phase).toBe(index === phases.length - 1);
        if (step.done) {
          r = step.value;
          console.info(
            "native ToObject catalog phases",
            JSON.stringify({ displaced, decoded, mode, phases, synchronousPhaseMs }),
          );
          console.info(
            "native ToObject catalog component",
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
        }
        await setImmediate();
      }, 120000);
    beforeEach(() => r.api.initialize());
    const same = (a: unknown, b: unknown) => expect(Object.is(a, b)).toBe(true);
    const run = (index: number, receiver: unknown, args: readonly unknown[], stored = false) => {
      const ordinal = index + 2,
        argv = r.vector(args);
      return stored
        ? r.api["stored" + ordinal](r.api["singleton" + ordinal].value, receiver, argv)
        : r.api["algorithm" + ordinal](receiver, argv);
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
    const prototypeOf = (value: unknown) => {
      const [status, parent] = r.api.getPrototypeOf(value);
      expect(status).toBe(1);
      return parent;
    };
    it("executes all eight real algorithm/guarded Call slots without completing the realm", () => {
      expect(WebAssembly.Module.imports(r.wasm)).toEqual([]);
      const pack = r.r.toObjectAlgorithms!;
      expect(pack.completionScope).toBe("native-object-to-object-calls");
      expect(pack.entries.map((e) => [e.request.intrinsic.id, e.request.intrinsic.callable.length])).toEqual([
        ["%Object.getPrototypeOf%", 1],
        ["%Object.prototype.valueOf%", 0],
        ["%get Object.prototype.__proto__%", 0],
        ["%Object.prototype.isPrototypeOf%", 1],
      ]);
      for (const entry of pack.entries)
        for (const token of [entry.algorithm, entry.lifted]) expect(r.liveNames).toContain(token.object.name);
      expect(r.r.tx.state).toBe("filling");
      expect(r.wholeRealmCompleted).toBe(false);
      expect(() => requireCompletedNativeObjectRealm(r.r.tx, pack.realm)).toThrow(/incomplete/);
    });
    it.each([0, -0, NaN, Infinity, -Infinity, 0.5, -(2 ** 30), 2 ** 30 - 1, 2 ** 30, 2 ** 53 - 1])(
      "wraps Number %s through the actual valueOf and prototype entries",
      (value) => {
        r.api.initializePrimitivePrototypes();
        const payload = r.api.boxNumber(value),
          a = run(1, payload, [], true),
          b = run(1, payload, []);
        expect(Object.is(a, b)).toBe(false);
        for (const result of [a, b]) {
          expect(r.api.payload_Number(result)).toBe(value);
          same(prototypeOf(result), r.api.prototype_Number());
        }
        same(run(0, null, [payload], true), r.api.prototype_Number());
        same(run(2, payload, [], true), r.api.prototype_Number());
      },
    );
    it("uses genuine Boolean/String/Symbol/BigInt factories and exact immutable payloads", () => {
      r.api.initializePrimitivePrototypes();
      for (const [kind, payload] of [
        ["Boolean", r.api.boxBoolean(0)],
        ["Boolean", r.api.boxBoolean(1)],
        ["String", r.api.text()],
        ["String", r.api.toObjectSlice()],
        ["String", r.api.toObjectRope(r.api.toObjectText(), r.api.text())],
        ["Symbol", r.api.symbol(88)],
        ["BigInt", r.api.wide96high()],
        ["BigInt", r.api.wideNegative()],
      ] as const) {
        const a = run(1, payload, [], true),
          b = run(1, payload, []);
        expect(Object.is(a, b)).toBe(false);
        same(prototypeOf(a), r.api["prototype_" + kind]());
        if (kind === "Boolean") expect(r.api.payload_Boolean(a)).toBe(r.api.readBoolean(payload));
        else same(r.api["payload_" + kind](a), payload);
        same(run(0, {}, [payload], true), r.api["prototype_" + kind]());
        same(run(2, payload, [{}], true), r.api["prototype_" + kind]());
      }
    });
    it("returns actual object/callable identities without primitive bootstrap or coercion", () => {
      for (const value of [
        r.api.objectPrototype.value,
        r.api.ordinary(0),
        r.api.singleton0.value,
        r.api.singleton2.value,
        r.api.singleton3.value,
        r.api.singleton4.value,
        r.api.newNumber(null, 3),
      ]) {
        same(run(1, value, [], true), value);
        same(run(0, null, [value], true), prototypeOf(value));
        same(run(2, value, [], true), prototypeOf(value));
      }
    });
    it("observes live prototypes and preserves object flags without copying", () => {
      const value = r.api.ordinary(0),
        parent = r.api.ordinary(0);
      same(run(0, null, [value]), null);
      expect(r.api.internalSetPrototypeOf(value, parent)).toBe(1);
      r.api.setFlags(value, 0x5a5a5a80);
      same(run(0, null, [value], true), parent);
      same(run(2, value, [], true), parent);
      same(run(1, value, [], true), value);
      expect(r.api.flags(value)).toBe(0x5a5a5a80);
    });
    it("uses argv[0] only for the static method and this only for both prototype methods", () => {
      let reads = 0;
      const trap = () => {
        reads++;
        throw Error("unexpected ignored argument access");
      };
      const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
      const value = r.api.ordinary(0);
      same(run(0, hostile, [value, hostile], true), null);
      same(run(1, value, [hostile], true), value);
      same(run(2, value, [hostile], true), null);
      expect(reads).toBe(0);
    });
    it("returns false for primitive V before inspecting this, ignored arguments or primitive bootstrap", () => {
      let reads = 0;
      const trap = () => {
        reads++;
        throw Error("unexpected receiver access");
      };
      const hostile = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap });
      r.api.clearObjectPrototype();
      for (const value of [
        null,
        r.api.undefinedValue(),
        r.api.boxNumber(3),
        r.api.boxBoolean(1),
        r.api.text(),
        r.api.symbol(1),
        r.api.wide96high(),
      ]) {
        for (const receiver of [null, r.api.undefinedValue(), hostile, r.api.undefinedCopy()]) {
          for (const stored of [false, true])
            expect(r.api.readBoolean(run(3, receiver, [value, hostile], stored))).toBe(0);
        }
      }
      expect(r.api.readBoolean(run(3, hostile, [], true))).toBe(0);
      expect(reads).toBe(0);
    });
    it("converts this before reading an object's null prototype, but never converts V", () => {
      const value = r.api.ordinary(0);
      for (const receiver of [null, r.api.undefinedValue()])
        for (const stored of [false, true]) typeError(() => run(3, receiver, [value], stored));
      r.api.initializePrimitivePrototypes();
      // Equal number payloads cannot replace object identity, including fresh ToObject(this).
      const a = r.api.newNumber(null, 7),
        b = r.api.newNumber(null, 7);
      expect(r.api.internalSetPrototypeOf(value, a)).toBe(1);
      expect(r.api.readBoolean(run(3, a, [value], true))).toBe(1);
      expect(r.api.readBoolean(run(3, b, [value], true))).toBe(0);
      expect(r.api.readBoolean(run(3, r.api.boxNumber(7), [value], true))).toBe(0);
      expect(r.api.readBoolean(run(3, a, [r.api.boxNumber(7)], true))).toBe(0);
    });
    it("walks live heterogeneous parents without copying or mutating flags", () => {
      const leaf = r.api.ordinary(0),
        middle = r.api.newNumber(null, 1),
        root = r.api.singleton2.value;
      expect(r.api.internalSetPrototypeOf(leaf, middle)).toBe(1);
      expect(r.api.internalSetPrototypeOf(middle, root)).toBe(1);
      r.api.setFlags(leaf, 0x20000080);
      for (const stored of [false, true]) {
        expect(r.api.readBoolean(run(3, root, [leaf], stored))).toBe(1);
        expect(r.api.readBoolean(run(3, middle, [leaf], stored))).toBe(1);
        expect(r.api.readBoolean(run(3, leaf, [leaf], stored))).toBe(0);
      }
      expect(r.api.internalSetPrototypeOf(middle, null)).toBe(1);
      expect(r.api.readBoolean(run(3, root, [leaf], true))).toBe(0);
      expect(r.api.flags(leaf)).toBe(0x20000080);
    });
    it("has no arbitrary prototype depth bound and detects malformed native cycles", () => {
      const first = r.api.ordinary(0),
        outside = r.api.ordinary(0);
      let tail = first;
      for (let i = 0; i < 4097; i++) {
        const next = r.api.ordinary(0);
        expect(r.api.internalSetPrototypeOf(tail, next)).toBe(1);
        tail = next;
      }
      expect(r.api.readBoolean(run(3, tail, [first], true))).toBe(1);
      expect(r.api.readBoolean(run(3, outside, [first], true))).toBe(0);
      for (const length of [1, 2, 3, 5]) {
        const nodes = Array.from({ length }, () => r.api.ordinary(0));
        nodes.forEach((node, i) => r.api.corruptParent(node, nodes[(i + 1) % length]));
        expect(() => run(3, outside, [nodes[0]], true)).toThrow(WebAssembly.RuntimeError);
      }
    });
    it("refuses unknown, stale or counterfeit V instead of returning a primitive false", () => {
      let reads = 0;
      const hostile = new Proxy(
        {},
        {
          get() {
            reads++;
            throw Error("unexpected host get");
          },
          getPrototypeOf() {
            reads++;
            throw Error("unexpected host prototype");
          },
        },
      );
      const other = new WebAssembly.Instance(r.wasm).exports as Record<string, any>;
      other.initialize();
      for (const value of [
        hostile,
        {},
        undefined,
        r.api.undefinedCopy(),
        other.undefinedValue(),
        other.ordinary(0),
        r.api.ordinary(1),
        r.api.source(),
      ]) {
        for (const stored of [false, true])
          expect(() => run(3, r.api.objectPrototype.value, [value], stored)).toThrow(WebAssembly.RuntimeError);
      }
      const value = r.api.ordinary(0);
      r.api.corruptParent(value, hostile);
      expect(() => run(3, r.api.objectPrototype.value, [value], true)).toThrow(WebAssembly.RuntimeError);
      expect(reads).toBe(0);
    });
    it("throws the actual nullish TypeError for omission or nullish this before bootstrap", () => {
      typeError(() => run(0, {}, [], true));
      for (const value of [null, r.api.undefinedValue()]) {
        typeError(() => run(0, {}, [value], true));
        typeError(() => run(1, value, [{}], true));
        typeError(() => run(2, value, [{}], true));
      }
      r.api.clearRealm();
      typeError(() => run(0, null, []));
      typeError(() => run(1, null, []));
      typeError(() => run(2, r.api.undefinedValue(), []));
    });
    it("refuses foreign, unready, counterfeit and hostile inputs without host property hooks", () => {
      const other = new WebAssembly.Instance(r.wasm).exports as Record<string, any>;
      other.initialize();
      let reads = 0;
      const trap = () => {
        reads++;
        throw Error("unexpected host access");
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
        "text",
        Symbol(),
        0n,
        undefined,
        r.api.undefinedCopy(),
        other.undefinedValue(),
        other.ordinary(0),
        r.api.ordinary(1),
        r.api.source(),
      ]) {
        for (const stored of [false, true]) {
          expect(() => run(0, null, [value], stored)).toThrow(WebAssembly.RuntimeError);
          expect(() => run(1, value, [], stored)).toThrow(WebAssembly.RuntimeError);
          expect(() => run(2, value, [], stored)).toThrow(WebAssembly.RuntimeError);
        }
      }
      expect(reads).toBe(0);
    });
    it("guards each actual lifted entry while stored transport invokes its supplied callee", () => {
      const value = r.api.ordinary(0),
        argv = r.vector([value]);
      for (let index = 0; index < 4; index++) {
        const ordinal = index + 2,
          entry = r.r.toObjectAlgorithms!.entries[index]!;
        // Stored transport reads self's actual function pointer. All catalog
        // Call signatures share this ABI, so another genuine function is a
        // legitimate callee, not an invalid receiver for a forced target.
        expect(r.r.algorithms.entries[0]!.lifted.object.typeIdx).toBe(entry.lifted.object.typeIdx);
        expect(r.api.readBoolean(r.api["stored" + ordinal](r.api.singleton0.value, value, argv))).toBe(1);
        for (const self of [
          r.api.singleton0.value,
          r.api.source(),
          r.api["coercionNative" + index](entry.metadata.metadata.id, 0),
          r.api["coercionNative" + index](entry.metadata.metadata.id, 1),
          r.api["coercionNative" + index](0, 0),
        ])
          typeError(() => r.api["lifted" + ordinal](self, value, argv));
      }
      const saved = [2, 3, 4, 5].map((ordinal) => r.api["singleton" + ordinal].value);
      r.api.initialize();
      for (const [index, self] of saved.entries()) {
        const ordinal = index + 2;
        typeError(() => r.api["lifted" + ordinal](self, value, r.vector([])));
        typeError(() => r.api["stored" + ordinal](self, value, r.vector([])));
      }
    });
    it.each(["renewRealm", "renewObjectPrototype"])(
      "refuses stale primitive factories after %s and restores real identities",
      (change) => {
        r.api.initializePrimitivePrototypes();
        const payload = r.api.boxNumber(2),
          previous = r.api.prototype_Number();
        r.api[change]();
        expect(() => run(0, null, [payload])).toThrow(WebAssembly.RuntimeError);
        expect(() => run(1, payload, [])).toThrow(WebAssembly.RuntimeError);
        expect(() => run(2, payload, [])).toThrow(WebAssembly.RuntimeError);
        r.api.initializePrimitivePrototypes();
        const next = r.api.prototype_Number();
        expect(Object.is(previous, next)).toBe(false);
        same(run(0, null, [payload]), next);
        same(prototypeOf(run(1, payload, [])), next);
        same(run(2, payload, []), next);
      },
    );
  });

describe("authenticated ToObject catalog owner", () => {
  const fixture = () => objectExtensibilityFixture(false, false, "interned", false, false, true, true, true);
  let r: ReturnType<typeof fixture>;
  beforeEach(() => {
    r = fixture();
  }, 120000);
  it("borrows only four fixed actual entries and rejects duplicate/copied/foreign owners", () => {
    const pack = r.toObjectAlgorithms!,
      d = r.toObjectAlgorithmsDependencies!,
      count = r.f.module.functions.length;
    expect(requireNativeObjectToObjectAlgorithms(r.tx, pack, d)).toBe(pack);
    expect(() => reserveNativeObjectToObjectAlgorithms(r.tx, d)).toThrow(/already has/);
    expect(r.f.module.functions.length).toBe(count);
    expect(() => requireNativeObjectToObjectAlgorithms(r.tx, { ...pack }, d)).toThrow(/copied/);
    expect(() => requireNativeObjectToObjectAlgorithms(r.tx, pack, { ...d })).toThrow(/different expected/);
    const other = fixture();
    expect(() => requireNativeObjectToObjectAlgorithms(other.tx, pack, d)).toThrow(/foreign/);
  });
  it("rejects accessors and copied kernel dependencies without evaluating getters", () => {
    let reads = 0;
    const d = r.toObjectAlgorithmsDependencies!,
      input = { ...d },
      count = r.f.module.functions.length;
    Object.defineProperty(input, "toObject", {
      enumerable: true,
      get() {
        reads++;
        return d.toObject;
      },
    });
    expect(() => reserveNativeObjectToObjectAlgorithms(r.tx, input)).toThrow(/own enumerable/);
    expect(reads).toBe(0);
    expect(() =>
      reserveNativeObjectToObjectAlgorithms(r.tx, { ...d, toObjectDependencies: { ...d.toObjectDependencies } }),
    ).toThrow(/different expected/);
    expect(() => reserveNativeObjectToObjectAlgorithms(r.tx, { ...d, booleanBoxes: { ...d.booleanBoxes } })).toThrow(
      /copied|foreign/,
    );
    expect(r.f.module.functions.length).toBe(count);
  });
  it("does not grant algorithm authority from reserved slots or missing prerequisites", () => {
    expect(() =>
      requireCompletedNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!, r.toObjectAlgorithmsDependencies!),
    ).toThrow(/missing canonical/);
    r.tx.freezeReservations();
    expect(() => fillNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!)).toThrow(/missing canonical/);
  });
  it("rejects an altered borrowed catalog declaration before it can become authority", () => {
    r.toObjectAlgorithms!.entries[0]!.algorithm.object.name = "substituted name";
    expect(() =>
      requireNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!, r.toObjectAlgorithmsDependencies!),
    ).toThrow(/altered function descriptor/);
    expect(r.tx.state).toBe("failed");
  });
  for (const role of ["kernel", "guard-error", "boolean-box", "boolean-global"] as const)
    describe(`receipt-valid substituted ${role} dependency`, () => {
      beforeEach(async () => {
        if (role === "kernel") {
          const fill = r.tx.fillFunction.bind(r.tx),
            target = r.toObject!.toObject;
          r.tx.fillFunction = (token, definition) =>
            fill(token, token === target ? { locals: [], body: [{ op: "unreachable" }] } : definition);
        } else if (role === "boolean-box") {
          const fill = r.tx.fillFunction.bind(r.tx),
            target = r.booleanBoxes.boxBoolean;
          r.tx.fillFunction = (token, definition) =>
            fill(token, token === target ? { locals: [], body: [{ op: "unreachable" }] } : definition);
        } else if (role === "boolean-global") {
          const fill = r.tx.fillGlobal.bind(r.tx),
            target = r.booleanBoxes.globals[0]!;
          r.tx.fillGlobal = (token, init) =>
            fill(token, token === target ? buildBooleanBoxInitializer(r.values.types.boxedBoolean.typeIndex, 0) : init);
        } else {
          const binding = requireNativeStringLiteral(
            r.tx,
            r.f.strings,
            "TypeError: incompatible native builtin function",
          );
          const inventory = nativeStringLiteralReservationInventory(r.tx, r.f.strings),
            wrong = planNativeStringLiteral(
              r.f.strings.layout,
              inventory.typePack.utf8Storage,
              "wrong guard message",
              "wtf16",
            );
          if (binding.kind !== "global" || wrong.kind !== "global")
            throw Error("lost receipt-bearing error leaf control");
          const fill = r.tx.fillGlobal.bind(r.tx);
          r.tx.fillGlobal = (token, init) => fill(token, token === binding.global ? wrong.init : init);
        }
        fillObjectExtensibilityDependencies(r);
        await setImmediate();
        fillNativePrimitivePrototypeIdentities(r.tx, r.primitivePrototypes!);
        await setImmediate();
        fillNativeToObjectKernel(r.tx, r.toObject!);
        await setImmediate();
        if (role === "kernel") r.tx.assertCompletedReservation(r.toObject!.toObject);
        else if (role === "boolean-box") r.tx.assertCompletedReservation(r.booleanBoxes.boxBoolean);
        else if (role === "boolean-global") r.tx.assertCompletedReservation(r.booleanBoxes.globals[0]!);
        else {
          const binding = requireNativeStringLiteral(
            r.tx,
            r.f.strings,
            "TypeError: incompatible native builtin function",
          );
          if (binding.kind !== "global") throw Error("lost error leaf positive control");
          r.tx.assertCompletedReservation(binding.global);
        }
      }, 120000);
      it("requires the independent canonical definition despite a valid allocator receipt", () => {
        expect(() => fillNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!)).toThrow(
          role === "kernel" || role === "boolean-box"
            ? /noncanonical function definition/
            : /noncanonical global initializer/,
        );
        expect(r.tx.state).toBe("failed");
      });
    });
  describe("completed native wrapping prerequisites", () => {
    beforeEach(async () => {
      fillObjectExtensibilityDependencies(r);
      await setImmediate();
      fillNativePrimitivePrototypeIdentities(r.tx, r.primitivePrototypes!);
      await setImmediate();
      fillNativeToObjectKernel(r.tx, r.toObject!);
      await setImmediate();
    }, 120000);
    describe("actual completed catalog", () => {
      let completed: ReturnType<typeof requireCompletedNativeObjectToObjectAlgorithms>;
      beforeEach(async () => {
        fillNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!);
        await setImmediate();
        // Compile-time authentication belongs to bounded component preparation,
        // just like the fill. Every real canonical check still executes here.
        completed = requireCompletedNativeObjectToObjectAlgorithms(
          r.tx,
          r.toObjectAlgorithms!,
          r.toObjectAlgorithmsDependencies!,
        );
        await setImmediate();
      }, 120000);
      it("authenticates all actual algorithm/lifted bodies without full realm completion", () => {
        expect(completed).toBe(r.toObjectAlgorithms);
        expect(() => fillNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!)).toThrow(/duplicate/);
        expect(() => requireCompletedNativeObjectRealm(r.tx, r.toObjectAlgorithms!.realm)).toThrow(/incomplete/);
      });
    });
    for (const index of [0, 1, 2, 3])
      for (const role of ["algorithm", "lifted"] as const)
        describe(`substituted entry${index} ${role}`, () => {
          beforeEach(async () => {
            const target = r.toObjectAlgorithms!.entries[index]![role],
              fill = r.tx.fillFunction.bind(r.tx);
            r.tx.fillFunction = (token, definition) =>
              fill(token, token === target ? { locals: [], body: [{ op: "unreachable" }] } : definition);
            fillNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!);
            await setImmediate();
            r.tx.assertCompletedReservation(target);
          }, 120000);
          it("refuses the actual receipt-valid substituted body", () => {
            expect(() =>
              requireCompletedNativeObjectToObjectAlgorithms(
                r.tx,
                r.toObjectAlgorithms!,
                r.toObjectAlgorithmsDependencies!,
              ),
            ).toThrow(/noncanonical function definition/);
          });
        });
    describe("actual interrupted partial fill", () => {
      beforeEach(async () => {
        const target = r.toObjectAlgorithms!.entries[1]!.algorithm,
          fill = r.tx.fillFunction.bind(r.tx);
        r.tx.fillFunction = (token, definition) => {
          if (token === target) throw Error("partial catalog interruption");
          fill(token, definition);
        };
        try {
          expect(() => fillNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!)).toThrow(/partial catalog/);
        } finally {
          r.tx.fillFunction = fill;
        }
        await setImmediate();
        r.tx.assertCompletedReservation(r.toObjectAlgorithms!.entries[0]!.algorithm);
        r.tx.assertCompletedReservation(r.toObjectAlgorithms!.entries[0]!.lifted);
      }, 120000);
      it("cannot retry a real partial fill into completion", () => {
        expect(() => fillNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!)).toThrow(/failed fill/);
        expect(() =>
          requireCompletedNativeObjectToObjectAlgorithms(
            r.tx,
            r.toObjectAlgorithms!,
            r.toObjectAlgorithmsDependencies!,
          ),
        ).toThrow(/missing canonical/);
      });
    });
    it("rejects a post-fill ToObject mutation at the allocator before semantic completion", () => {
      r.toObject!.toObject.object.body = [{ op: "unreachable" }];
      expect(() => fillNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!)).toThrow(
        /altered completed function/,
      );
      expect(r.tx.state).toBe("failed");
    });
    it("rejects a post-fill long guard-error mutation at the allocator", () => {
      const binding = requireNativeStringLiteral(r.tx, r.f.strings, "TypeError: incompatible native builtin function");
      if (binding.kind !== "global") throw Error("lost direct error leaf positive control");
      binding.global.object.init = [{ op: "ref.null", typeIdx: r.f.strings.layout.anyStrTypeIdx }];
      expect(() => fillNativeObjectToObjectAlgorithms(r.tx, r.toObjectAlgorithms!)).toThrow(/altered completed global/);
      expect(r.tx.state).toBe("failed");
    });
  });
});
