// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it } from "vitest";
import { objectIsFixture, objectIsRuntime, fillObjectIsDependencies } from "./helpers/native-object-is-fixture.js";
import { fillDescriptorDependencies } from "./helpers/native-descriptor-fixture.js";
import { fillNativeObjectDescriptorResources } from "../src/backend/wasmgc/resources/native-object-descriptors.js";
import {
  reserveNativeObjectIsAlgorithm,
  fillNativeObjectIsAlgorithm,
  requireNativeObjectIsAlgorithm,
  requireCompletedNativeObjectIsAlgorithm,
} from "../src/backend/wasmgc/resources/native-object-is.js";
import { fillNativeBooleanBoxResources } from "../src/backend/wasmgc/resources/native-booleans.js";
import {
  fillNativeInvocationSubstrateResources,
  declareNativeInvocationSubstrateResources,
  reserveNativeInvocationSubstrateResources,
} from "../src/backend/wasmgc/resources/native-invocation-substrate.js";
import {
  declareNativeRealmObjectLayouts,
  reserveNativeRealmObjectLayouts,
  fillNativeRealmObjectLayouts,
} from "../src/backend/wasmgc/resources/native-realm-object-layouts.js";
import {
  reserveNativeObjectRealmDeclarations,
  requireNativeObjectRealmDeclarations,
  reserveNativeObjectRealmException,
  fillNativeObjectRealmDeclarations,
  requireCompletedNativeObjectRealm,
  nativeObjectRealmDeclarationInventory,
} from "../src/backend/wasmgc/resources/native-object-realm.js";
import { beginNativeSourceClosureEmission } from "../src/ir/program-native-invocation.js";
import { nativeStringLiteralReservationInventory } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { descriptorSource } from "./helpers/native-descriptor-fixture.js";
import { deriveNativeRealmRequirements } from "../src/ir/program/native-realm-requirements.js";
import { declareNativePublicBuiltinFunctionRequests } from "../src/backend/wasmgc/resources/native-builtin-function-requests.js";
import { requireNativeValueReservationsFor } from "../src/backend/wasmgc/resources/native-values.js";

const population = (f: ReturnType<typeof objectIsFixture>) => [
  f.module.types.length,
  f.module.functions.length,
  f.module.globals.length,
];
const fromBits = (bits: bigint) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits, true);
  return view.getFloat64(0, true);
};
for (const [displaced, decoded, mode] of [
  [false, false, "interned"],
  [true, false, "allocating"],
  [true, true, "interned"],
] as const)
  describe(`genuine Object.is catalog algorithm, displaced=${displaced}, decoded=${decoded}, mode=${mode}`, () => {
    let r: ReturnType<typeof objectIsRuntime>;
    beforeAll(() => {
      r = objectIsRuntime(displaced, decoded, mode);
    });
    it("executes with zero imports and the actual catalog/transport/Boolean owners", () => {
      expect(r.imports).toEqual([]);
      expect(r.f.objectIs.completionScope).toBe("native-object-is-algorithm");
      expect(r.f.objectIs.algorithm.key).toBe(r.f.requests.key + ":%Object.is%:algorithm");
      const result = r.call([r.ex.boxNumber!(42), r.ex.boxNumber!(42)]);
      expect(r.ex.isBoolean!(result)).toBe(1);
      expect(r.ex.unboxBoolean!(result)).toBe(1);
      expect(Object.is(requireCompletedNativeObjectIsAlgorithm(r.f.tx, r.f.objectIs), r.f.objectIs)).toBe(true);
    });
    it("uses canonical undefined for omitted arguments, not spare null backing cells", () => {
      const undefinedValue = r.ex.undefinedValue!();
      for (const [args, expected] of [
        [[], 1],
        [[undefinedValue], 1],
        [[null], 0],
        [[null, null], 1],
        [[undefinedValue, null], 0],
      ] as const)
        expect(r.test(args)).toBe(expected);
    });
    it.each([
      [0, -0],
      [-0, 0],
      [0, 0],
      [42, 42],
      [42, 43],
      [Infinity, Infinity],
      [Infinity, -Infinity],
      [Number.MIN_VALUE, 0],
    ])("matches native numeric Object.is(%s,%s)", (a, b) => {
      expect(r.test([r.ex.boxNumber!(a), r.ex.boxNumber!(b)])).toBe(Number(Object.is(a, b)));
    });
    it("equates distinct NaN payloads through the actual argument transport", () => {
      const a = fromBits(0x7ff8000000000001n),
        b = fromBits(0xfff8000000000002n);
      expect(r.test([r.ex.boxNumber!(a), r.ex.boxNumber!(b)])).toBe(1);
      expect(r.test([r.ex.boxNumber!(a)])).toBe(0);
    });
    it("compares Boolean, full-width BigInt, native String and actual reference values", () => {
      const object = r.ex.createNull!(),
        other = r.ex.createNull!();
      expect(r.test([object, object])).toBe(1);
      expect(r.test([object, other])).toBe(0);
      expect(r.test([r.ex.boxBoolean!(1), r.ex.boxBoolean!(1)])).toBe(1);
      expect(r.test([r.ex.boxBoolean!(1), r.ex.boxNumber!(1)])).toBe(0);
      expect(Object.is(r.ex.key!(), r.ex.textCopy!())).toBe(false);
      if (displaced) {
        expect(r.ex.isUtf8!(r.ex.key!())).toBe(0);
        expect(r.ex.isUtf8!(r.ex.textCopy!())).toBe(1);
      }
      expect(r.test([r.ex.key!(), r.ex.textCopy!()])).toBe(1);
      expect(r.test([r.ex.wide64!(), r.ex.wide64!()])).toBe(1);
      expect(r.test([r.ex.wide64!(), r.ex.zero!()])).toBe(0);
      expect(r.test([r.ex.wide96one!(), r.ex.wide96high!()])).toBe(0);
      expect(r.test([r.ex.symbol!(1), r.ex.symbol!(1)])).toBe(1);
      expect(r.test([r.ex.symbol!(1), r.ex.symbol!(2)])).toBe(0);
    });
    it("ignores receiver and tail values while real argv growth preserves the first two operands", () => {
      let reads = 0;
      const unused = new Proxy(
        {},
        {
          get() {
            reads++;
            throw Error("unused value inspected");
          },
        },
      );
      const n = r.ex.boxNumber!(42);
      expect(r.test([n, n, ...Array(12).fill(unused)], unused)).toBe(1);
      expect(reads).toBe(0);
    });
    it("rejects a foreign argument vector rather than silently treating it as omitted", () => {
      expect(() => r.ex.algorithm!(null, {})).toThrow();
    });
  });

describe("Object.is algorithm custody and realm association", () => {
  it("rejects an alternate genuine same-ledger Call transport before allocating an algorithm", () => {
    const f = objectIsFixture(),
      requirements = { key: "alternate:substrate" };
    const plan = declareNativeInvocationSubstrateResources(
      requirements,
      f.vectors.base ? { vectorBaseKey: f.vectors.base.key } : {},
    );
    const substrate = reserveNativeInvocationSubstrateResources(f.tx, requirements, f.substrateDependencies, plan);
    const before = population(f);
    expect(() => reserveNativeObjectIsAlgorithm(f.tx, { ...f.objectIsDependencies, substrate })).toThrow(
      /different shared argument/,
    );
    expect(population(f)).toEqual(before);
  });
  it("does not turn copied opaque dependencies or equal dependency data into authority", () => {
    const f = objectIsFixture(),
      before = population(f);
    for (const replacement of [
      { sameValue: { ...f.sameValue } },
      { booleanBoxes: { ...f.booleanBoxes } },
      { sameValueDependencies: { ...f.sameValueDependencies } },
      { substrate: { ...f.substrate } },
    ])
      expect(() => reserveNativeObjectIsAlgorithm(f.tx, { ...f.objectIsDependencies, ...replacement })).toThrow(
        /foreign|copied|substituted/,
      );
    expect(population(f)).toEqual(before);
  });
  it.each(["hidden", "accessor", "inherited"])(
    "the primitive owner rejects %s expected-source fields without callbacks",
    (kind) => {
      const f = objectIsFixture();
      let reads = 0;
      const source = { program: f.program, projection: f.projection };
      if (kind === "inherited") {
        Reflect.deleteProperty(source, "program");
        Object.setPrototypeOf(source, { program: f.program });
      } else
        Object.defineProperty(
          source,
          "program",
          kind === "hidden"
            ? { value: f.program, enumerable: false }
            : {
                enumerable: true,
                get() {
                  reads++;
                  return f.program;
                },
              },
        );
      expect(() => requireNativeValueReservationsFor(f.tx, f.values, f.valuePlan, f.valueDependencies, source)).toThrow(
        /own enumerable/,
      );
      expect(reads).toBe(0);
    },
  );
  it("rejects a different genuine source program even with the same ledger/transport/literals", () => {
    const f = objectIsFixture(),
      source = descriptorSource(true);
    const realm = deriveNativeRealmRequirements(source.program, source.projection)!;
    const requests = declareNativePublicBuiltinFunctionRequests(f.tx, realm, f.requestDependencies);
    const before = population(f);
    expect(() => reserveNativeObjectIsAlgorithm(f.tx, { ...f.objectIsDependencies, requests })).toThrow(
      /not issued for this program/,
    );
    expect(population(f)).toEqual(before);
    expect(Object.is(requireNativeObjectIsAlgorithm(f.tx, f.objectIs, f.requests), f.objectIs)).toBe(true);
  });
  it("rejects copied, foreign and different genuine catalog owners before allocation", () => {
    const f = objectIsFixture(),
      other = objectIsFixture(),
      before = population(f);
    expect(() => requireNativeObjectIsAlgorithm(f.tx, { ...f.objectIs }, f.requests)).toThrow(/copied/);
    expect(() => requireNativeObjectIsAlgorithm(other.tx, f.objectIs, f.requests)).toThrow(/foreign/);
    expect(() => requireNativeObjectIsAlgorithm(f.tx, f.objectIs, other.requests)).toThrow(/different catalog/);
    expect(() => reserveNativeObjectIsAlgorithm(f.tx, { ...f.objectIsDependencies, requests: other.requests })).toThrow(
      /foreign/,
    );
    expect(population(f)).toEqual(before);
  });
  it("rejects duplicate slots and dependency substitution without new reservations", () => {
    const f = objectIsFixture(),
      before = population(f);
    expect(() => reserveNativeObjectIsAlgorithm(f.tx, f.objectIsDependencies)).toThrow(/duplicate planned/);
    expect(population(f)).toEqual(before);
    f.objectIsDependencies.booleanBoxes = { ...f.booleanBoxes };
    expect(() => requireNativeObjectIsAlgorithm(f.tx, f.objectIs, f.requests)).toThrow(/changed dependency identity/);
  });
  it.each(["hidden", "accessor", "inherited"])("rejects %s dependency fields without evaluating getters", (kind) => {
    const f = objectIsFixture(),
      before = population(f);
    let reads = 0;
    const input = { ...f.objectIsDependencies };
    if (kind === "inherited") {
      Reflect.deleteProperty(input, "booleanBoxes");
      Object.setPrototypeOf(input, { booleanBoxes: f.booleanBoxes });
    } else
      Object.defineProperty(
        input,
        "booleanBoxes",
        kind === "hidden"
          ? { value: f.booleanBoxes, enumerable: false }
          : {
              enumerable: true,
              get() {
                reads++;
                return f.booleanBoxes;
              },
            },
      );
    expect(() => reserveNativeObjectIsAlgorithm(f.tx, input)).toThrow(/own|dependency/);
    expect(reads).toBe(0);
    expect(population(f)).toEqual(before);
  });
  it("requires all canonical dependencies and refuses a caller-filled algorithm", () => {
    const f = objectIsFixture();
    f.tx.freezeReservations();
    expect(() => fillNativeObjectIsAlgorithm(f.tx, f.objectIs)).toThrow(/incomplete|canonical/);
    expect(f.objectIs.algorithm.object.body).toEqual([]);
    f.tx.fillFunction(f.objectIs.algorithm, { locals: [], body: [{ op: "ref.null.extern" }] });
    expect(() => requireCompletedNativeObjectIsAlgorithm(f.tx, f.objectIs)).toThrow(/canonical algorithm fill/);
  });
  it("canonically fills once and detects post-completion body mutation", () => {
    const f = objectIsFixture();
    fillObjectIsDependencies(f);
    fillNativeObjectIsAlgorithm(f.tx, f.objectIs);
    expect(() => fillNativeObjectIsAlgorithm(f.tx, f.objectIs)).toThrow(/duplicate canonical/);
    expect(Object.is(requireCompletedNativeObjectIsAlgorithm(f.tx, f.objectIs), f.objectIs)).toBe(true);
    f.objectIs.algorithm.object.body.push({ op: "drop" });
    expect(() => requireCompletedNativeObjectIsAlgorithm(f.tx, f.objectIs)).toThrow();
  });
  it("the real full catalog borrows exactly this slot but cannot certify the incomplete realm", () => {
    const f = objectIsFixture();
    const realmState = reserveNativeRealmObjectLayouts(
      f.tx,
      "object-is:realm-state",
      { objects: f.layouts, objectPlan: f.lookupDependencies.layoutPlan },
      declareNativeRealmObjectLayouts("object-is:realm-state", f.layouts.object.key, f.layouts.propMap.key),
    );
    const strings = nativeStringLiteralReservationInventory(f.tx, f.strings).typePack;
    const source = beginNativeSourceClosureEmission(
      f.tx,
      f.realm.source!,
      {
        vectors: f.vectors,
        vectorPlan: f.vectorPlan,
        strings: { types: strings, key: strings.key, utf8Storage: strings.utf8Storage },
        realmState,
      },
      f.requests,
    );
    const exception = reserveNativeObjectRealmException(f.tx, f.realm, { required: true, shared: false });
    const dependencies = {
      requests: f.requests,
      closures: source.types.closures,
      closurePlan: source.types.closurePlan,
      layouts: realmState,
      substrate: f.substrate,
      vectors: f.vectors,
      vectorPlan: f.vectorPlan,
      exception,
      source: source.types,
      objectIs: f.objectIs,
    };
    const before = population(f);
    for (const objectIs of [null, { ...f.objectIs }])
      expect(() => reserveNativeObjectRealmDeclarations(f.tx, f.realm, { ...dependencies, objectIs } as never)).toThrow(
        /issued owner|copied/,
      );
    expect(population(f)).toEqual(before);
    const declarations = reserveNativeObjectRealmDeclarations(f.tx, f.realm, dependencies);
    const entry = declarations.entries.find((row) => row.request.intrinsic.id === "%Object.is%")!;
    expect(Object.is(entry.algorithm, f.objectIs.algorithm)).toBe(true);
    expect(f.module.functions.filter((row) => row === f.objectIs.algorithm.object)).toHaveLength(1);
    expect(
      nativeObjectRealmDeclarationInventory(f.tx, declarations).functions.filter((row) => row === f.objectIs.algorithm),
    ).toHaveLength(1);
    expect(Object.is(requireNativeObjectRealmDeclarations(f.tx, declarations, dependencies), declarations)).toBe(true);
    f.tx.freezeReservations();
    fillDescriptorDependencies(f);
    fillNativeObjectDescriptorResources(f.tx, f.pack, f.exception);
    fillNativeRealmObjectLayouts(f.tx, realmState);
    fillNativeObjectRealmDeclarations(f.tx, declarations);
    fillNativeInvocationSubstrateResources(f.tx, f.substrate);
    fillNativeBooleanBoxResources(f.tx, f.booleanBoxes);
    fillNativeObjectIsAlgorithm(f.tx, f.objectIs);
    expect(() => requireCompletedNativeObjectRealm(f.tx, declarations)).toThrow(
      /full Object\/Function algorithms and runtime population remain incomplete/,
    );
    expect(
      declarations.entries.filter((row) => row !== entry).every((row) => row.algorithm.object.body.length === 0),
    ).toBe(true);
  });
});
