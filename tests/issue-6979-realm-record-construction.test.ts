// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { constructionFixture, constructionRuntime, RECORD_SOURCE } from "./helpers/native-construction-fixture.js";
import { fillDescriptorDependencies } from "./helpers/native-descriptor-fixture.js";
import { fillNativeObjectDescriptorResources } from "../src/backend/wasmgc/resources/native-object-descriptors.js";
import {
  declareNativeObjectConstructionResources,
  reserveNativeObjectConstructionResources,
  fillNativeObjectConstructionResources,
  requireNativeObjectConstructionReservations,
} from "../src/backend/wasmgc/resources/native-object-construction.js";
import {
  declareNativeObjectLayouts,
  reserveNativeObjectLayouts,
} from "../src/backend/wasmgc/resources/native-object-layouts.js";
import {
  declareNativeRealmObjectLayouts,
  reserveNativeRealmObjectLayouts,
} from "../src/backend/wasmgc/resources/native-realm-object-layouts.js";

describe("actual record demands using the issued realm ordinary subtype", () => {
  for (const [offset, decoded] of [
    [false, false],
    [true, false],
    [true, true],
  ])
    it(`executes source-ordered native definitions with independent live realm state (${offset}, ${decoded})`, () => {
      const { f, exports: ex, imports } = constructionRuntime(offset, decoded, RECORD_SOURCE, true);
      expect(imports).toEqual([]);
      expect(f.requirements.constructors).toHaveLength(3);
      expect(f.requirements.gaps).toHaveLength(3); // Actual default realm still missing.
      const index = f.requirements.constructors.findIndex((d) => d.carriers.length === 4);
      const demand = f.requirements.constructors[index]!;
      const ref = ex.createNull!(),
        text = ex.key!();
      const args = demand.carriers.map(
        (carrier) => ({ number: 42, boolean: 1, "native-string": text, "live-reference": ref })[carrier],
      );
      expect(() => ex["initialize" + index]!(null, ...args)).toThrow(WebAssembly.RuntimeError);
      // A genuine realm identity allocation is required; no Function.prototype shortcut.
      ex["realm:initialize"]!(null);
      const first = ex["initialize" + index]!(null, ...args);
      const second = ex["initialize" + index]!(first, ...args);
      expect(Object.is(first, second)).toBe(false);
      expect(ex.prototype!(first)).toBeNull();
      expect(Object.is(ex.prototype!(second), first)).toBe(true);
      expect(ex.count!(first)).toBe(4);
      const a = ex.objectState!(first),
        b = ex.objectState!(second);
      expect(Object.is(a, b)).toBe(false);
      expect(Object.is(ex["realm:realm"]!(a), ex["realm:realm"]!(b))).toBe(true);
      ex["realm:setPrototype"]!(a, ref);
      expect(Object.is(ex.prototype!(first), ref)).toBe(true);
      expect(Object.is(ex.prototype!(second), first)).toBe(true);
      for (const [sequence, key] of demand.keys.entries()) {
        const entry = ex.entry!(first, ex["key:" + key]!());
        expect(entry[0]).toBe(7);
        expect(entry[2]).toBe(sequence);
      }
      expect(ex.unboxNumber!(ex.entry!(first, ex["key:z"]!())[1])).toBe(42);
      expect(ex.unboxBoolean!(ex.entry!(first, ex["key:a"]!())[1])).toBe(1);
      expect(Object.is(ex.entry!(first, ex["key:text"]!())[1], text)).toBe(true);
      expect(Object.is(ex.entry!(first, ex["key:ref"]!())[1], ref)).toBe(true);
      // Replacing the control anchor does not retag previously allocated objects.
      ex["realm:initialize"]!(null);
      const third = ex["initialize" + index]!(null, ...args);
      expect(Object.is(ex["realm:realm"]!(ex.objectState!(third)), ex["realm:realm"]!(a))).toBe(false);
      const grow = f.requirements.constructors.findIndex((d) => d.carriers.length === 12);
      const grown = ex["initialize" + grow]!(first, ...Array(12).fill(7));
      expect(ex.count!(grown)).toBe(12);
      expect(Object.is(ex.prototype!(grown), first)).toBe(true);
    });

  it("retains a real zero-field allocation and state without inventing a Boolean helper", () => {
    const { f, exports: ex } = constructionRuntime(true, true, "export function make(){return {};}", true);
    expect(f.requirements.constructors).toHaveLength(1);
    expect(f.constructionPlans[0]!.declarations.map((d) => d.role[1])).toEqual([
      f.requirements.constructors[0]!.key,
      "realm-state-allocation",
    ]);
    ex["realm:initialize"]!(null);
    const first = ex.initialize0!(null),
      second = ex.initialize0!(first);
    expect(ex.count!(first)).toBe(0);
    expect(ex.count!(second)).toBe(0);
    expect(Object.is(first, second)).toBe(false);
    expect(Object.is(ex.objectState!(first), ex.objectState!(second))).toBe(false);
    expect(Object.is(ex.prototype!(second), first)).toBe(true);
  });

  it("rejects copied/foreign realm state and substitutions before reserving constructor slots", () => {
    const f = constructionFixture(false, false, RECORD_SOURCE, true);
    const other = constructionFixture(false, false, RECORD_SOURCE, true);
    const before = f.module.functions.length;
    for (const realmState of [{ ...f.realmState! }, other.realmState!])
      expect(() =>
        reserveNativeObjectConstructionResources(
          f.tx,
          "bad",
          f.requirements,
          0,
          { ...f.constructionDependencies, realmState },
          f.constructionPlans[0]!,
        ),
      ).toThrow(/foreign|copied/);
    expect(f.module.functions).toHaveLength(before);
    f.constructionDependencies.realmState = other.realmState;
    expect(() =>
      requireNativeObjectConstructionReservations(
        f.tx,
        f.constructors[0]!,
        f.requirements,
        0,
        f.constructionDependencies,
      ),
    ).toThrow(/substituted dependency/);
  });

  it("rejects hidden/accessor/inherited optional state without evaluating getters", () => {
    const f = constructionFixture(false, false, RECORD_SOURCE, true);
    const before = f.module.functions.length;
    let reads = 0;
    for (const kind of ["hidden", "accessor", "inherited"]) {
      const d = { descriptors: f.pack, descriptorDependencies: f.dependencies };
      if (kind === "inherited") Object.setPrototypeOf(d, { realmState: f.realmState });
      else
        Object.defineProperty(
          d,
          "realmState",
          kind === "hidden"
            ? { value: f.realmState }
            : {
                enumerable: true,
                get() {
                  reads++;
                  return f.realmState;
                },
              },
        );
      expect(() =>
        reserveNativeObjectConstructionResources(f.tx, "bad", f.requirements, 0, d, f.constructionPlans[0]!),
      ).toThrow(/own enumerable data/);
    }
    expect(reads).toBe(0);
    expect(f.module.functions).toHaveLength(before);
  });

  it("rejects a genuine same-ledger realm with a different own-storage owner", () => {
    const f = constructionFixture(false, false, RECORD_SOURCE, true);
    const objectPlan = declareNativeObjectLayouts({ key: "other:objects", extensible: true });
    const objects = reserveNativeObjectLayouts(f.tx, { key: "other:objects", extensible: true }, objectPlan);
    const realmState = reserveNativeRealmObjectLayouts(
      f.tx,
      "other:realm",
      { objects, objectPlan },
      declareNativeRealmObjectLayouts("other:realm", objects.object.key, objects.propMap.key),
    );
    const before = f.module.functions.length;
    expect(() =>
      reserveNativeObjectConstructionResources(
        f.tx,
        "bad",
        f.requirements,
        0,
        { ...f.constructionDependencies, realmState },
        f.constructionPlans[0]!,
      ),
    ).toThrow(/foreign expected dependencies/);
    expect(f.module.functions).toHaveLength(before);
  });

  it("does not treat a descriptive realm-allocation recipe as an issued realm owner", () => {
    const f = constructionFixture();
    const stringType = f.strings.types.find((t) => t.typeIndex === f.strings.layout.anyStrTypeIdx)!;
    const plan = declareNativeObjectConstructionResources(
      "bad",
      f.requirements.constructors[0]!,
      f.layouts.object.key,
      stringType.key,
      true,
    );
    const before = f.module.functions.length;
    expect(() =>
      reserveNativeObjectConstructionResources(f.tx, "bad", f.requirements, 0, f.constructionDependencies, plan),
    ).toThrow(/substituted declaration plan/);
    expect(f.module.functions).toHaveLength(before);
  });

  it("requires canonical realm layout completion before any constructor slot is filled", () => {
    const f = constructionFixture(false, false, RECORD_SOURCE, true);
    f.tx.freezeReservations();
    fillDescriptorDependencies(f);
    fillNativeObjectDescriptorResources(f.tx, f.pack, f.exception);
    expect(() => fillNativeObjectConstructionResources(f.tx, f.constructors[0]!)).toThrow(/canonical initializer fill/);
    expect(f.constructors.every((p) => p.initialize.object.body.length === 0)).toBe(true);
  });
});
