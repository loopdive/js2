// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compile } from "../src/index.js";
import { bigintOperandValues, bigintComparisonCases } from "./helpers/native-bigint-carrier-fixture.js";
import {
  descriptorFixture,
  completeDescriptorFixture,
  fillDescriptorDependencies,
  descriptorRuntime,
  descriptorSource,
} from "./helpers/native-descriptor-fixture.js";
import {
  deriveNativeObjectAccessRequirements,
  assertNativeObjectAccessRequirementsCurrent,
} from "../src/ir/program/native-object-access-requirements.js";
import {
  declareNativeObjectDescriptorResources,
  reserveNativeObjectDescriptorResources,
  requireNativeObjectDescriptorReservations,
  fillNativeObjectDescriptorResources,
  requireCompletedNativeObjectDescriptors,
  nativeObjectDescriptorReservationInventory,
} from "../src/backend/wasmgc/resources/native-object-descriptors.js";
import {
  declareNativeObjectSameValueResources,
  reserveNativeObjectSameValueResources,
  requireNativeObjectSameValueReservations,
  requireCompletedNativeObjectSameValue,
} from "../src/backend/wasmgc/resources/native-object-same-value.js";

describe("genuine ordinary getter C1 census", () => {
  it.each([false, true])("retains actual source/descriptor/allocation associations decoded=%s", (decoded) => {
    const { program, projection } = descriptorSource(decoded);
    const access = deriveNativeObjectAccessRequirements(program, projection);
    assertNativeObjectAccessRequirementsCurrent(access);
    expect(access.uses.map((row) => row.feature)).toEqual([
      "js.object.create-default",
      "js.object.define-accessor",
      "js.object.define-accessor",
      "js.object.get",
    ]);
    expect(access.getters).toHaveLength(1);
    const getter = access.getters[0]!;
    expect(getter.actualArity).toBe(0);
    const allocation = access.demands.occurrences[getter.allocationOccurrence]!.instruction;
    expect(allocation.kind).toBe("closure.new");
    if (allocation.kind !== "closure.new") throw Error("missing real getter allocation");
    expect(getter.rawAllocationId).toBe(allocation.alloc);
    expect(getter.captures).toEqual(allocation.captures);
    expect(getter.captureTypes).toEqual(allocation.captureFieldTypes);
    expect(access.gaps.some((row) => row.detail.includes("implicit-prototype"))).toBe(true);
    expect(() => assertNativeObjectAccessRequirementsCurrent({ ...access })).toThrow("unissued");
  });
});
describe("issued SameValue dependency", () => {
  it("completes only after the actual primitive and string providers", () => {
    const f = descriptorFixture();
    expect(
      Object.is(requireNativeObjectSameValueReservations(f.tx, f.sameValue, f.sameValueDependencies), f.sameValue),
    ).toBe(true);
    expect(() => requireCompletedNativeObjectSameValue(f.tx, f.sameValue, f.sameValueDependencies)).toThrow(
      "missing canonical fill",
    );
    completeDescriptorFixture(f);
    expect(
      Object.is(requireCompletedNativeObjectSameValue(f.tx, f.sameValue, f.sameValueDependencies), f.sameValue),
    ).toBe(true);
  });
  it.each(["booleans", "bigints", "values", "equality"] as const)("rejects copied %s before allocation", (role) => {
    const f = descriptorFixture(),
      before = structuredClone(f.module);
    const changed = { ...f.sameValueDependencies, [role]: { ...f.sameValueDependencies[role] } };
    expect(() =>
      reserveNativeObjectSameValueResources(f.tx, "bad", changed, declareNativeObjectSameValueResources("bad")),
    ).toThrow();
    expect(f.module).toStrictEqual(before);
  });
  it("rejects replaced dependencies and post-fill body mutation", () => {
    const f = descriptorFixture();
    completeDescriptorFixture(f);
    requireCompletedNativeObjectSameValue(f.tx, f.sameValue, f.sameValueDependencies);
    expect(() => requireNativeObjectSameValueReservations(f.tx, f.sameValue, { ...f.sameValueDependencies })).toThrow(
      "foreign expected dependencies",
    );
    f.sameValue.sameValue.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeObjectSameValue(f.tx, f.sameValue, f.sameValueDependencies)).toThrow(
      "altered completed function",
    );
  });
});
describe("issued descriptor installation owner", () => {
  it("owns all five functions and preserves the exact canonical void signatures", () => {
    const f = descriptorFixture(true),
      inventory = nativeObjectDescriptorReservationInventory(f.tx, f.pack, f.dependencies);
    expect(inventory.plan.declarations).toHaveLength(5);
    expect(inventory.functions).toHaveLength(5);
    expect(
      inventory.plan.declarations
        .slice(2)
        .every((row) => row.space === "function" && row.signature.results.length === 0),
    ).toBe(true);
    expect(f.module.exports).toEqual([]);
    completeDescriptorFixture(f);
    expect(Object.is(requireCompletedNativeObjectDescriptors(f.tx, f.pack, f.dependencies), f.pack)).toBe(true);
  });
  it.each(["pack", "dependencies", "access", "storage", "sameValue", "errors", "closures"] as const)(
    "rejects copied %s after a positive control",
    (role) => {
      const f = descriptorFixture();
      requireNativeObjectDescriptorReservations(f.tx, f.pack, f.dependencies);
      if (role === "pack" || role === "dependencies") {
        expect(() =>
          requireNativeObjectDescriptorReservations(
            f.tx,
            role === "pack" ? { ...f.pack } : f.pack,
            role === "dependencies" ? { ...f.dependencies } : f.dependencies,
          ),
        ).toThrow();
      } else {
        const before = structuredClone(f.module);
        expect(() =>
          reserveNativeObjectDescriptorResources(
            f.tx,
            "bad",
            { ...f.dependencies, [role]: { ...f.dependencies[role] } },
            declareNativeObjectDescriptorResources("bad"),
          ),
        ).toThrow();
        expect(f.module).toStrictEqual(before);
      }
    },
  );
  it("refuses a late declaration collision before any partial reservation", () => {
    const f = descriptorFixture();
    f.tx.reserveFunction("next:define-attributes", "collision", { params: [], results: [] });
    const before = structuredClone(f.module);
    expect(() =>
      reserveNativeObjectDescriptorResources(
        f.tx,
        "next",
        f.dependencies,
        declareNativeObjectDescriptorResources("next"),
      ),
    ).toThrow();
    expect(f.module).toStrictEqual(before);
  });
  it("requires dependency completion before filling any own function", () => {
    const f = descriptorFixture();
    f.tx.freezeReservations();
    const before = structuredClone(f.module);
    expect(() => fillNativeObjectDescriptorResources(f.tx, f.pack, f.exception)).toThrow();
    expect(f.module).toStrictEqual(before);
  });
  it("does not authenticate an external fill", () => {
    const f = descriptorFixture();
    f.tx.freezeReservations();
    fillDescriptorDependencies(f);
    f.tx.fillFunction(f.pack.defineData, { locals: [], body: [] });
    expect(() => requireCompletedNativeObjectDescriptors(f.tx, f.pack, f.dependencies)).toThrow(
      "missing canonical fill",
    );
    expect(() => fillNativeObjectDescriptorResources(f.tx, f.pack, f.exception)).toThrow("duplicate function fill");
  });
  it("rejects a foreign exception token before filling any own body", () => {
    const f = descriptorFixture(),
      other = descriptorFixture();
    f.tx.freezeReservations();
    fillDescriptorDependencies(f);
    const before = structuredClone(f.module);
    expect(() => fillNativeObjectDescriptorResources(f.tx, f.pack, other.exception)).toThrow();
    expect(f.module).toStrictEqual(before);
  });
  it("retains post-completion body currentness", () => {
    const f = descriptorFixture();
    completeDescriptorFixture(f);
    requireCompletedNativeObjectDescriptors(f.tx, f.pack, f.dependencies);
    f.pack.defineAccessor.object.body.push({ op: "nop" });
    expect(() => requireCompletedNativeObjectDescriptors(f.tx, f.pack, f.dependencies)).toThrow(
      "altered completed function",
    );
  });
});
let runtime: ReturnType<typeof descriptorRuntime> | undefined;
const actual = () => (runtime ??= descriptorRuntime(true));
function throwsTypeError(run: () => unknown) {
  const r = actual();
  try {
    run();
  } catch (error) {
    expect(error instanceof WebAssembly.Exception).toBe(true);
    if (!(error instanceof WebAssembly.Exception)) throw error;
    expect(error.is(r.exception)).toBe(true);
    return;
  }
  throw Error("expected actual tagged TypeError");
}
let controls: Promise<{ native: Record<string, () => number>; legacy: WebAssembly.Exports }> | undefined;
function pairedDescriptorControls() {
  return (controls ??= (async () => {
    const source = readFileSync(
      new URL("./fixtures/issue-3518-descriptor-undefined-controls.ts.txt", import.meta.url),
      "utf8",
    );
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const scope = { exports: {} as Record<string, () => number> };
    runInNewContext(js, scope);
    const compiled = await compile(source, { target: "standalone", fileName: "descriptor-undefined-controls.ts" });
    expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
    expect(WebAssembly.validate(compiled.binary)).toBe(true);
    const module = new WebAssembly.Module(compiled.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    return { native: scope.exports, legacy: new WebAssembly.Instance(module).exports };
  })());
}
type DescriptorControl = {
  name: string;
  observe: (r: ReturnType<typeof actual>, object: object) => boolean;
};
const descriptorControls: DescriptorControl[] = [
  {
    name: "explicitNull",
    observe: (r, object) => {
      r.defineAccessor(object, r.key(), r.closure(), null, 292);
      r.defineData(object, r.key(), null, 128);
      return r.entry(object, r.key())[1] === null;
    },
  },
  {
    name: "explicitUndefined",
    observe: (r, object) => {
      r.defineAccessor(object, r.key(), r.closure(), null, 292);
      r.defineData(object, r.key(), r.undefinedValue(), 128);
      return Object.is(r.entry(object, r.key())[1], r.undefinedValue());
    },
  },
  {
    name: "genericPreservesGetter",
    observe: (r, object) => {
      r.defineAccessor(object, r.key(), r.closure(), null, 292);
      r.defineAttributes(object, r.key(), 18);
      const entry = r.entry(object, r.key());
      return r.closureValue(entry[2]) === 7 && (entry[0] & 10) === 10;
    },
  },
  {
    name: "nonConfigurableRejects",
    observe: (r, object) => {
      r.defineAccessor(object, r.key(), r.closure(), null, 256);
      throwsTypeError(() => r.defineData(object, r.key(), null, 9));
      return r.closureValue(r.entry(object, r.key())[2]) === 7;
    },
  },
  {
    name: "writableFalseDefaultsUndefined",
    observe: (r, object) => {
      r.defineAccessor(object, r.key(), r.closure(), null, 292);
      r.defineData(object, r.key(), null, 8);
      const entry = r.entry(object, r.key());
      return Object.is(entry[1], r.undefinedValue()) && (entry[0] & 9) === 0;
    },
  },
  {
    name: "existingNullPreserved",
    observe: (r, object) => {
      r.defineData(object, r.key(), null, 164);
      r.defineData(object, r.key(), null, 9);
      return r.entry(object, r.key())[1] === null;
    },
  },
];
describe("native descriptor and SameValue execution with real dependencies", () => {
  it.each(bigintComparisonCases)("uses exact carrier SameValue for %s and %s", (a, b) => {
    const r = actual(),
      left = r[a](),
      right = r[b]();
    expect(r.sameValue(left, right)).toBe(Number(bigintOperandValues[a] === bigintOperandValues[b]));
    const object = r.create();
    r.defineData(object, r.key(), left, 128);
    if (bigintOperandValues[a] === bigintOperandValues[b]) r.defineData(object, r.key(), right, 128);
    else throwsTypeError(() => r.defineData(object, r.key(), right, 128));
    expect(r.sameValue(r.entry(object, r.key())[1], left)).toBe(1);
  });
  it.each(descriptorControls)(
    "pairs native resource, retained compiler and exact Node source: $name",
    async ({ name, observe }) => {
      const pair = await pairedDescriptorControls();
      const expected = pair.native[name]!();
      expect(expected).toBe(1);
      const r = actual();
      expect(Number(observe(r, r.create()))).toBe(expected);
      expect((pair.legacy[name] as () => number)()).toBe(expected);
    },
  );
  it.each([
    [0, -0],
    [42, 42],
    [42, 43],
    [NaN, NaN],
    [Infinity, Infinity],
  ] as const)("matches SameValue(%s,%s)", (a, b) => {
    const r = actual();
    expect(r.sameValue(r.boxNumber(a), r.boxNumber(b))).toBe(Number(Object.is(a, b)));
  });
  it.each([
    [0, 0],
    [1, 1],
    [0, 1],
  ] as const)("compares real Boolean carriers %i/%i", (a, b) => {
    const r = actual();
    expect(r.sameValue(r.boxBoolean(a), r.boxBoolean(b))).toBe(Number(a === b));
  });
  it.each([
    [1n, 1n],
    [1n, 2n],
    [-(1n << 63n), -(1n << 63n)],
  ] as const)("compares actual BigInt payloads %s/%s", (a, b) => {
    const r = actual();
    expect(r.sameValue(r.boxBigInt(a), r.boxBigInt(b))).toBe(Number(a === b));
  });
  it("keeps undefined, null, number and native string identities distinct", () => {
    const r = actual(),
      undef = r.undefinedValue();
    expect(r.sameValue(null, null)).toBe(1);
    expect(r.sameValue(undef, undef)).toBe(1);
    expect(r.sameValue(null, undef)).toBe(0);
    expect(r.sameValue(r.key(), r.key())).toBe(1);
    expect(r.sameValue(r.key(), r.other())).toBe(0);
    expect(r.sameValue(r.boxBigInt(1n), r.boxNumber(1))).toBe(0);
  });
  it("installs real null separately from canonical undefined", () => {
    const r = actual(),
      object = r.create();
    expect(r.defineData(object, r.key(), null, 191)).toBeUndefined();
    expect(r.entry(object, r.key())[1]).toBeNull();
    r.defineData(object, r.key(), r.undefinedValue(), 191);
    expect(Object.is(r.entry(object, r.key())[1], r.undefinedValue())).toBe(true);
  });
  it("merges attributes while preserving a data value", () => {
    const r = actual(),
      object = r.create(),
      value = r.boxNumber(7);
    r.defineData(object, r.key(), value, 191);
    r.defineAttributes(object, r.key(), 16);
    expect(r.entry(object, r.key())[0]).toBe(5);
    expect(r.unboxNumber(r.entry(object, r.key())[1])).toBe(7);
  });
  it("preserves the other accessor half on sequential definitions", () => {
    const r = actual(),
      object = r.create(),
      getter = r.closure(),
      setter = r.closure();
    expect(r.closureValue(getter)).toBe(7);
    r.defineAccessor(object, r.key(), getter, null, 310);
    r.defineAccessor(object, r.key(), null, setter, 566);
    const entry = r.entry(object, r.key());
    expect(entry[0]).toBe(14);
    expect(Object.is(entry[2], getter)).toBe(true);
    expect(Object.is(entry[3], setter)).toBe(true);
  });
  it("ignores arbitrary absent-half operands and clears an explicitly undefined half", () => {
    const r = actual(),
      object = r.create(),
      getter = r.closure();
    r.defineAccessor(object, r.key(), getter, { ignored: true }, 310);
    r.defineAccessor(object, r.key(), r.undefinedValue(), { ignored: true }, 310);
    expect(r.entry(object, r.key())[2]).toBeNull();
  });
  it.each([null, 7, {}, "callable"])("rejects explicitly supplied noncallable getter %s", (value) => {
    const r = actual(),
      object = r.create();
    throwsTypeError(() => r.defineAccessor(object, r.key(), value, null, 310));
    expect(r.has(object, r.key())).toBe(0);
  });
  it("preserves SameValue for non-configurable native accessors", () => {
    const r = actual(),
      object = r.create(),
      first = r.closure(),
      second = r.closure();
    expect(r.sameValue(first, first)).toBe(1);
    expect(r.sameValue(first, second)).toBe(0);
    r.defineAccessor(object, r.key(), first, null, 256);
    r.defineAccessor(object, r.key(), first, null, 256);
    throwsTypeError(() => r.defineAccessor(object, r.key(), second, null, 256));
    expect(Object.is(r.entry(object, r.key())[2], first)).toBe(true);
  });
  it("rejects non-configurable data changes before mutation", () => {
    const r = actual(),
      object = r.create();
    r.defineData(object, r.key(), r.boxNumber(7), 128);
    r.defineData(object, r.key(), r.boxNumber(7), 128);
    throwsTypeError(() => r.defineData(object, r.key(), r.boxNumber(8), 128));
    expect(r.unboxNumber(r.entry(object, r.key())[1])).toBe(7);
  });
  it("materializes undefined for new generic descriptors and accessor-to-data conversion", () => {
    const r = actual(),
      object = r.create();
    r.defineAttributes(object, r.other(), 54);
    expect(Object.is(r.entry(object, r.other())[1], r.undefinedValue())).toBe(true);
    r.defineAccessor(object, r.key(), r.closure(), null, 310);
    r.defineData(object, r.key(), null, 9);
    expect(Object.is(r.entry(object, r.key())[1], r.undefinedValue())).toBe(true);
    expect(r.entry(object, r.key())[0] & 8).toBe(0);
  });
  it("compares the exact accessor-to-data source with native Node and the retained compiler", async () => {
    const source = readFileSync(new URL("./fixtures/issue-3518-descriptor-undefined.ts.txt", import.meta.url), "utf8");
    const js = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const scope = { exports: {} as { run?: () => number } };
    runInNewContext(js, scope);
    const native = scope.exports.run!();
    expect(native).toBe(1);
    const r = actual(),
      object = r.create();
    r.defineAccessor(object, r.key(), r.closure(), null, 292);
    r.defineData(object, r.key(), null, 9);
    const installed = Number(Object.is(r.entry(object, r.key())[1], r.undefinedValue()));
    expect(installed).toBe(native);
    const legacy = await compile(source, { target: "standalone", fileName: "descriptor-undefined.ts", emitWat: true });
    expect(legacy.success, JSON.stringify(legacy.errors)).toBe(true);
    expect(WebAssembly.validate(legacy.binary)).toBe(true);
    const module = new WebAssembly.Module(legacy.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = new WebAssembly.Instance(module);
    const observed = (instance.exports.run as () => number)();
    console.info(
      "descriptor undefined exact-source comparison",
      JSON.stringify({ native, installed, legacy: observed }),
    );
    expect(observed).toBe(native);
  });
  it("preserves status2 rather than treating an unhandled prototype as absence", () => {
    const r = actual();
    expect(r.has(r.create(), r.missing())).toBe(0);
    expect(r.has(r.createDefault(), r.missing())).toBe(2);
  });
  it.each([0, NaN, Infinity, -1, 310.5, 1024])("rejects invalid accessor mask %s without table mutation", (mask) => {
    const r = actual(),
      object = r.create();
    throwsTypeError(() => r.defineAccessor(object, r.key(), r.closure(), null, mask));
    expect(r.has(object, r.key())).toBe(0);
  });
});
