// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { constructionFixture, constructionRuntime, constructionSource } from "./helpers/native-construction-fixture.js";
import {
  descriptorFixture,
  fillDescriptorDependencies,
  completeDescriptorFixture,
} from "./helpers/native-descriptor-fixture.js";
import {
  deriveNativeObjectConstructionRequirements,
  assertNativeObjectConstructionRequirementsCurrent,
} from "../src/ir/program/native-object-construction-requirements.js";
import { deriveNativeObjectAccessRequirements } from "../src/ir/program/native-object-access-requirements.js";
import {
  reserveNativeObjectConstructionResources,
  fillNativeObjectConstructionResources,
  requireCompletedNativeObjectConstruction,
  requireNativeObjectConstructionReservations,
} from "../src/backend/wasmgc/resources/native-object-construction.js";
import { fillNativeObjectDescriptorResources } from "../src/backend/wasmgc/resources/native-object-descriptors.js";
import { SOURCE_OBJECT_CONSTRUCTION, isSourceObjectConstruction } from "../src/ir/runtime/object-construction.js";

describe("owned native explicit-prototype record initialization", () => {
  for (const [offset, decoded] of [
    [false, false],
    [true, false],
    [true, true],
  ])
    it(`executes canonical storage/descriptors/boxing with live identity (offset=${offset}, replay=${decoded})`, () => {
      const { f, exports: ex, imports } = constructionRuntime(offset, decoded);
      expect(imports).toEqual([]);
      expect(f.requirements.constructors).toHaveLength(3);
      expect(f.requirements.gaps).toHaveLength(3); // Default source realm is NOT completed by an explicit-prototype kernel.
      const ref = ex.createNull!(),
        text = ex.key!();
      for (const [index, demand] of f.requirements.constructors.entries()) {
        if (demand.carriers.length === 12) continue;
        const args = demand.carriers.map(
          (carrier, i) => ({ number: 42, boolean: 1, "native-string": text, "live-reference": ref })[carrier],
        );
        const object = ex["initialize" + index]!(null, ...args);
        expect(ex.count!(object)).toBe(4);
        expect(ex.prototype!(object)).toBeNull();
        const row = (key: string) => ex.entry!(object, ex["key:" + key]!());
        for (const key of demand.keys) {
          const [flags, , sequence] = row(key);
          expect(flags).toBe(7);
          expect(sequence).toBe(demand.keys.indexOf(key));
        }
        expect(ex.unboxNumber!(row("z")[1])).toBe(42);
        expect(ex.isBoolean!(row("a")[1])).toBe(1);
        expect(ex.unboxBoolean!(row("a")[1])).toBe(1);
        expect(row("text")[1]).toBe(text);
        expect(row("ref")[1]).toBe(ref);
        ex.defineData!(object, ex["key:z"]!(), row("z")[1], 184); // Inherited readonly data must not block CreateDataProperty.
        const second = ex["initialize" + index]!(
          object,
          ...demand.carriers.map((carrier, i) => (carrier === "boolean" ? 0 : args[i])),
        );
        expect(second === object).toBe(false);
        expect(ex.prototype!(second)).toBe(object);
        expect(ex.count!(second)).toBe(4);
        expect(ex.entry!(second, ex["key:z"]!())[0]).toBe(7);
        expect(ex.unboxBoolean!(ex.entry!(second, ex["key:a"]!())[1])).toBe(0);
        ex.defineData!(object, ex["key:inherited"]!(), ref, 191);
        expect(ex.has!(second, ex["key:inherited"]!())).toBe(1);
        expect(ex.count!(second)).toBe(4);
        // Explicit foreign prototype/string rejection is a test-wrapper cast, not production admission.
        expect(() => ex["initialize" + index]!({}, ...args)).toThrow(WebAssembly.RuntimeError);
        const stringIndex = demand.carriers.indexOf("native-string");
        const invalidString = [...args];
        invalidString[stringIndex] = "not a native carrier";
        expect(() => ex["initialize" + index]!(null, ...invalidString)).toThrow(WebAssembly.RuntimeError);
        for (const number of [-0, NaN, Infinity]) {
          const special = ex["initialize" + index]!(
            null,
            ...demand.carriers.map((carrier, i) => (carrier === "number" ? number : args[i])),
          );
          expect(Object.is(ex.unboxNumber!(ex.entry!(special, ex["key:z"]!())[1]), number)).toBe(true);
        }
      }
      const index = f.requirements.constructors.findIndex((row) => row.carriers.length === 12),
        demand = f.requirements.constructors[index]!;
      const grown = ex["initialize" + index]!(null, ...demand.carriers.map(() => 7));
      expect(ex.count!(grown)).toBe(12);
      for (const [sequence, key] of demand.keys.entries()) {
        const row = ex.entry!(grown, ex["key:" + key]!());
        expect(row[0]).toBe(7);
        expect(ex.unboxNumber!(row[1])).toBe(7);
        expect(row[2]).toBe(sequence);
      }
    });

  it("keeps source-order variants distinct despite identical storage shapes", () => {
    const f = constructionFixture();
    const records = f.requirements.constructors.filter((row) => row.carriers.length === 4);
    expect(records).toHaveLength(2);
    expect(records[0]!.shape).toEqual(records[1]!.shape);
    expect(records[0]!.keys).not.toEqual(records[1]!.keys);
    expect(records[0]!.key).not.toBe(records[1]!.key);
    expect(records.map((row) => row.carriers)).toEqual(
      Array(2).fill(["boolean", "live-reference", "native-string", "number"]),
    );
  });

  it("refuses copied requirements, packs, wrong source and constructor indices", () => {
    const f = constructionFixture(),
      pack = f.constructors[0]!,
      deps = f.constructionDependencies;
    expect(() => assertNativeObjectConstructionRequirementsCurrent({ ...f.requirements })).toThrow(/unissued/);
    expect(() => requireNativeObjectConstructionReservations(f.tx, { ...pack }, f.requirements, 0, deps)).toThrow(
      /copied owner/,
    );
    expect(() => requireNativeObjectConstructionReservations(f.tx, pack, f.requirements, 1, deps)).toThrow(
      /foreign expected/,
    );
    expect(() => requireNativeObjectConstructionReservations(f.tx, pack, f.requirements, 0, { ...deps })).toThrow(
      /foreign expected/,
    );
    const foreign = constructionFixture();
    expect(() => requireNativeObjectConstructionReservations(foreign.tx, pack, f.requirements, 0, deps)).toThrow(
      /foreign/,
    );
    const before = f.module.functions.length;
    expect(() =>
      reserveNativeObjectConstructionResources(
        f.tx,
        "wrong",
        f.requirements,
        0,
        foreign.constructionDependencies,
        f.constructionPlans[0]!,
      ),
    ).toThrow(/foreign/);
    expect(() =>
      reserveNativeObjectConstructionResources(f.tx, "wrong", f.requirements, 999, deps, f.constructionPlans[0]!),
    ).toThrow(/missing actual/);
    expect(f.module.functions).toHaveLength(before);
  });

  it("preflights duplicate keys and mismatched plans before reserving any function", () => {
    const f = constructionFixture(),
      before = f.module.functions.length;
    expect(() =>
      reserveNativeObjectConstructionResources(
        f.tx,
        "construction:0",
        f.requirements,
        0,
        f.constructionDependencies,
        f.constructionPlans[0]!,
      ),
    ).toThrow(/already|duplicate|reserved/);
    const other = constructionFixture();
    expect(() =>
      reserveNativeObjectConstructionResources(
        other.tx,
        "different",
        other.requirements,
        0,
        other.constructionDependencies,
        other.constructionPlans[0]!,
      ),
    ).toThrow(/substituted declaration/);
    expect(f.module.functions).toHaveLength(before);
  });

  it("requires canonical dependencies and its own canonical fill, not caller-filled bodies", () => {
    const f = constructionFixture(),
      pack = f.constructors[0]!;
    expect(() => fillNativeObjectConstructionResources(f.tx, pack)).toThrow(/invalid phase/);
    f.tx.freezeReservations();
    expect(() => fillNativeObjectConstructionResources(f.tx, pack)).toThrow(/missing canonical fill/);
    fillDescriptorDependencies(f);
    fillNativeObjectDescriptorResources(f.tx, f.pack, f.exception);
    expect(() =>
      requireCompletedNativeObjectConstruction(f.tx, pack, f.requirements, 0, f.constructionDependencies),
    ).toThrow(/missing canonical fill/);
    f.tx.fillFunction(pack.initialize, { locals: [], body: [{ op: "ref.null.extern" }] });
    expect(() =>
      requireCompletedNativeObjectConstruction(f.tx, pack, f.requirements, 0, f.constructionDependencies),
    ).toThrow(/missing canonical fill/);
  });

  it("authenticates completion and refuses duplicate canonical fill", () => {
    const f = constructionFixture(),
      pack = f.constructors[0]!;
    completeDescriptorFixture(f);
    fillNativeObjectConstructionResources(f.tx, pack);
    expect(requireCompletedNativeObjectConstruction(f.tx, pack, f.requirements, 0, f.constructionDependencies)).toBe(
      pack,
    );
    expect(() => fillNativeObjectConstructionResources(f.tx, pack)).toThrow(/duplicate canonical fill/);
  });

  it("does not turn empty access demand or missing source facts into construction authority", () => {
    const empty = descriptorFixture();
    expect(deriveNativeObjectConstructionRequirements(empty.access).constructors).toHaveLength(0);
    const source = constructionSource(),
      program = source.program;
    const altered = {
      ...program,
      allocations: {
        ...program.allocations,
        metadata: program.allocations.metadata.map((row) => ({
          ...row,
          entries: row.entries.filter(([key]) => key !== SOURCE_OBJECT_CONSTRUCTION),
        })),
      },
    };
    const access = deriveNativeObjectAccessRequirements(altered, altered.runtime[0]!);
    const requirements = deriveNativeObjectConstructionRequirements(access);
    expect(requirements.constructors).toHaveLength(0);
    expect(requirements.gaps).toHaveLength(3);
    expect(requirements.gaps.every((row) => row.detail.includes("source order"))).toBe(true);
  });

  it("rejects duplicate logical fields instead of certifying an incomplete key permutation", () => {
    const facts = { schema: "source-object-construction-v1", kind: "data", keys: ["a", "b"] };
    expect(isSourceObjectConstruction(facts, [{ name: "a" }, { name: "b" }])).toBe(true);
    expect(isSourceObjectConstruction(facts, [{ name: "a" }, { name: "a" }])).toBe(false);
  });

  for (const [text, reason] of [
    ["export function make(n:number):{__proto__:number}{return {__proto__:n};}", "prototype-setter"],
  ])
    it(`retains an explicit construction gap for ${reason}`, () => {
      const source = constructionSource(text);
      const access = deriveNativeObjectAccessRequirements(source.program, source.projection);
      const requirements = deriveNativeObjectConstructionRequirements(access);
      expect(requirements.constructors).toHaveLength(0);
      expect(requirements.gaps).toHaveLength(1);
      expect(requirements.gaps[0]!.detail).toContain(reason);
    });

  it("rejects altered projection operands instead of granting source allocation authority", () => {
    const source = constructionSource();
    let edits = 0;
    const functions = source.projection.prepared.functions.map((fn) => ({
      ...fn,
      blocks: fn.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instr) => {
          if (instr.kind !== "object.new") return instr;
          edits++;
          return { ...instr, values: [...instr.values].reverse() };
        }),
      })),
    }));
    expect(edits).toBe(3);
    const projection = { ...source.projection, prepared: { ...source.projection.prepared, functions } };
    const program = { ...source.program, runtime: [projection] };
    const access = deriveNativeObjectAccessRequirements(program, projection);
    expect(() => deriveNativeObjectConstructionRequirements(access)).toThrow(/construction differs/);
  });

  it("retains an explicit method-construction gap with a positively observed allocation", () => {
    const source = constructionSource(
      "export function make(n:number):number{const o={method():number{return 1;}};return o.method()+n;}",
    );
    const access = deriveNativeObjectAccessRequirements(source.program, source.projection);
    expect(access.demands.occurrences.filter((row) => row.instruction.kind === "object.new")).toHaveLength(2); // Both views.
    const requirements = deriveNativeObjectConstructionRequirements(access);
    expect(requirements.constructors).toHaveLength(0);
    expect(requirements.gaps).toHaveLength(1);
    expect(requirements.gaps[0]!.detail).toContain("method");
    const f = descriptorFixture(false, source);
    expect(() =>
      reserveNativeObjectConstructionResources(
        f.tx,
        "method",
        requirements,
        0,
        { descriptors: f.pack, descriptorDependencies: f.dependencies },
        { declarations: [], reservationSteps: [] },
      ),
    ).toThrow(/missing actual selected constructor/);
  });
});
