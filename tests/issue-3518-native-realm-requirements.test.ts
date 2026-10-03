// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { NATIVE_REALM_CATALOG } from "../src/runtime/contracts/native-realm-catalog.js";
import {
  deriveNativeRealmRequirements,
  assertNativeRealmRequirementsCurrent,
} from "../src/ir/program/native-realm-requirements.js";
import {
  planNativeRealmLiterals,
  requireNativeRealmLiteralPlan,
  readNativeRealmLiteralInput,
} from "../src/backend/wasmgc/program/native-realm-literals.js";
import {
  prepareNativeProgramStringInput,
  reserveNativeProgramFoundation,
} from "../src/backend/wasmgc/program/native-realm.js";
import {
  assertNativeStringValueReservationInput,
  planNativeStringValuePhysical,
} from "../src/backend/wasmgc/program/native-string-values.js";
import { prepareGetterProgram } from "./helpers/native-getter-invocation-fixture.js";
import {
  REALM_CALL_SOURCE,
  REALM_NO_SOURCE,
  realmInput,
  prepareBackendRealmProgram,
} from "./helpers/native-realm-source-integration.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { forEachInstrDeep, type IrInstrCall } from "../src/ir/core/nodes.js";
import type { NativeStringValueReservationInput } from "../src/backend/wasmgc/program/native-string-values.js";
import { deriveNativeVectorResourcePlan } from "../src/ir/program/native-vector-resources.js";
import { nativeRealmReservationInventory } from "../src/backend/wasmgc/program/native-realm.js";

let encoded: string;
beforeAll(() => {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  encoded = encodePreparedIrProgram(prepareGetterProgram(REALM_CALL_SOURCE));
  vi.unstubAllEnvs();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await setImmediate();
});
const source = () => decodePreparedIrProgram(encoded);
const population = (module: ReturnType<typeof createEmptyModule>) => [
  module.types.length,
  module.functions.length,
  module.globals.length,
  module.tags.length,
];
function selected() {
  return realmInput(source());
}
const intrinsic = (id: string) => NATIVE_REALM_CATALOG.intrinsics.find((row) => row.id === id)!;
const property = (id: string, name: string) => intrinsic(id).properties.find((row) => row.key.value === name)!;

describe("semantic native realm catalog and real selected demands", () => {
  it("retains the complete Object/Function identity graph and unavailable algorithms", () => {
    const rows = NATIVE_REALM_CATALOG.intrinsics;
    expect(rows).toHaveLength(45);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(
      rows.filter((row) => row.callable?.implementation !== "unavailable" && row.callable).map((row) => row.id),
    ).toEqual(["%Function.prototype%", "%ThrowTypeError%"]);
    for (const row of rows) {
      expect(Object.isFrozen(row)).toBe(true);
      if (row.prototype !== null) expect(rows.some((parent) => parent.id === row.prototype)).toBe(true);
      for (const p of row.properties) {
        const refs = p.kind === "accessor" ? [p.get, p.set] : p.value.kind === "intrinsic" ? [p.value.id] : [];
        for (const id of refs) expect(rows.some((target) => target.id === id)).toBe(true);
      }
      if (row.callable?.implementation === "unavailable") {
        expect(row.callable.algorithm.length).toBeGreaterThan(0);
        expect(row.callable.requires.length).toBeGreaterThan(0);
      }
    }
    expect(NATIVE_REALM_CATALOG.remaining).toContain("public Number(value) provider");
  });
  it("retains callable prototype, constructor cycles and immutable Object prototype semantics", () => {
    expect(intrinsic("%Object.prototype%")).toMatchObject({
      prototype: null,
      immutablePrototype: true,
      constructible: false,
    });
    expect(intrinsic("%Function.prototype%")).toMatchObject({
      prototype: "%Object.prototype%",
      callable: { length: 0, initialName: "" },
    });
    for (const name of ["Object", "Function"]) {
      expect(intrinsic(`%${name}%`).constructible).toBe(true);
      expect(property(`%${name}%`, "prototype")).toMatchObject({
        writable: false,
        configurable: false,
        value: { id: `%${name}.prototype%` },
      });
      expect(property(`%${name}.prototype%`, "constructor")).toMatchObject({
        writable: true,
        configurable: true,
        value: { id: `%${name}%` },
      });
    }
    expect(intrinsic("%Object.assign%").callable?.length).toBe(2);
    expect(intrinsic("%Function%").callable?.length).toBe(1);
  });
  it("retains restricted accessors, symbol-name attributes and legacy optional tags", () => {
    for (const name of ["caller", "arguments"])
      expect(property("%Function.prototype%", name)).toMatchObject({
        kind: "accessor",
        get: "%ThrowTypeError%",
        set: "%ThrowTypeError%",
        enumerable: false,
        configurable: true,
      });
    expect(intrinsic("%ThrowTypeError%").extensible).toBe(false);
    expect(property("%ThrowTypeError%", "length")).toMatchObject({ writable: false, configurable: false });
    expect(property("%Function.prototype%", "Symbol.hasInstance")).toMatchObject({
      key: { kind: "symbol" },
      writable: false,
      enumerable: false,
      configurable: false,
    });
    expect(intrinsic("%Function.prototype[@@hasInstance]%").callable?.initialName).toBe("[Symbol.hasInstance]");
    for (const name of ["__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"])
      expect(property("%Object.prototype%", name)).toMatchObject({ normativeOptional: true, legacy: true });
    expect(intrinsic("%Function.prototype%").aliases).toContain("Function.prototype");
  });
  it("issues only from actual selected program/projection/source occurrences", () => {
    const { requirements: r, program, projection } = selected();
    expect(r.program).toBe(program);
    expect(r.projection).toBe(projection);
    expect(r.source!.units).toHaveLength(1);
    expect(r.description.sourceUnits).toEqual(r.source!.units.map((row) => row.unitId));
    expect(r.description.sourceAllocationOccurrences.length).toBeGreaterThan(0);
    expect(r.description.objectUses).toEqual([]);
    expect(r.access.uses).toEqual([]);
    expect(r.description.catalog).toEqual(NATIVE_REALM_CATALOG);
    expect(r.description.completionScope).toBe("native-realm-bootstrap");
    expect(r.description.unavailable.length).toBeGreaterThan(40);
    expect(() => assertNativeRealmRequirementsCurrent(r)).not.toThrow();
  });
  it("selects a constructed typed-IR no-source object demand through genuine preparation", () => {
    const program = prepareBackendRealmProgram();
    const { requirements: r, input } = realmInput(program);
    expect(r.source).toBeUndefined();
    expect(r.description.sourceUnits).toEqual([]);
    expect(r.description.objectUses.map((row) => row.feature)).toEqual(["js.object.create-null"]);
    expect(r.description.numberUses).toEqual([]);
    for (const functions of [program.ir.functions, r.projection.prepared.functions]) {
      const calls = functions
        .flatMap((fn) => fn.blocks.flatMap((block) => block.instrs))
        .filter((row) => row.kind === "call");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        target: { binding: { kind: "intrinsic" }, name: "js.object.create-null" },
        args: [],
        resultType: { kind: "val", val: { kind: "externref" } },
      });
    }
    expect(input.invocationRequirements).toBeUndefined();
    expect(input.plan.mode).toBe("realm-bootstrap");
  });
  it("retains the original genuine Number/object frontend preparation refusal", () => {
    expect(() => prepareGetterProgram(REALM_NO_SOURCE)).toThrow("runtime feature js.number.from-value has no provider");
  });
  it("does not select a scalar program with no realm use", () => {
    const program = prepareGetterProgram("export function run(): number { return 7; }");
    expect(deriveNativeRealmRequirements(program, program.runtime[0]!)).toBeUndefined();
  });
  it("rejects copied realm packs, foreign projections and foreign source issuers", () => {
    const a = selected(),
      b = selected();
    expect(() => assertNativeRealmRequirementsCurrent({ ...a.requirements })).toThrow(/unissued|copied/);
    expect(() => deriveNativeRealmRequirements(a.program, b.projection)).toThrow();
    expect(() => deriveNativeRealmRequirements(a.program, a.projection, b.requirements.source)).toThrow(
      /foreign|detached/,
    );
  });
  it("authenticates demand currentness before a literal cache hit", () => {
    const original = source();
    const projection = {
      ...original.runtime[0]!,
      prepared: {
        ...original.runtime[0]!.prepared,
        functions: structuredClone(original.runtime[0]!.prepared.functions),
      },
    };
    const program = {
      ...original,
      ir: { ...original.ir, functions: structuredClone(original.ir.functions) },
      runtime: [projection],
    };
    const r = deriveNativeRealmRequirements(program, projection)!;
    const literal = planNativeRealmLiterals(r, false);
    let call: IrInstrCall | undefined;
    for (const fn of r.projection.prepared.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (node) => {
            if (node.kind === "call") call ??= node;
          });
    if (!call) throw Error("actual call demand missing");
    (call.target as { name: string }).name += "-stale";
    expect(() => assertNativeRealmRequirementsCurrent(r)).toThrow();
    expect(() => planNativeRealmLiterals(r, false)).toThrow();
    expect(() => requireNativeRealmLiteralPlan(literal, r, false)).toThrow();
  });
});

describe("authenticated supplemental literals and reservation input", () => {
  for (const utf8 of [false, true])
    it(`preserves prior literal order and distinct UTF16 empty sentinel, utf8=${utf8}`, () => {
      const program = source(),
        projection = program.runtime[0]!,
        r = deriveNativeRealmRequirements(program, projection)!;
      const input = prepareNativeProgramStringInput(program, projection, { utf8Storage: utf8 }, undefined, r)!;
      if ("kind" in input) throw Error(JSON.stringify(input));
      const prior = planNativeStringValuePhysical(
        collectNativeStringValueDemands(program, projection),
        { representation: "native-string", utf8Storage: utf8, stringConcatEmptyIdentity: true },
        input.invocationRequirements,
      );
      if (prior.kind !== "planned") throw Error("real invocation lost original string plan");
      expect(input.plan.literalRequirements.literals.slice(0, prior.plan.literalRequirements.literals.length)).toEqual(
        prior.plan.literalRequirements.literals,
      );
      expect(input.plan.literalRequirements.literals).toContainEqual({ value: "", encoding: "wtf16" });
      const utf16 = planNativeRealmLiterals(r, false).literals;
      expect(utf16.every((row) => row.encoding === "wtf16")).toBe(true);
      expect(utf16.filter((row) => row.value === "")).toEqual([{ value: "", encoding: "wtf16" }]);
      expect(utf16.filter((row) => row.value === "length")).toEqual([{ value: "length", encoding: "wtf16" }]);
      const selectedLiterals = utf16.map((row) => ({
        value: row.value,
        encoding: utf8 ? "utf8-guaranteed" : "wtf16",
      }));
      expect(input.realmLiterals!.literals).toEqual([
        ...selectedLiterals,
        ...(utf8
          ? [
              { value: "", encoding: "wtf16" },
              { value: "length", encoding: "wtf16" },
            ]
          : []),
      ]);
      if (utf8) {
        expect(input.realmLiterals!.literals).toContainEqual({ value: "", encoding: "utf8-guaranteed" });
        expect(input.realmLiterals!.literals).toContainEqual({ value: "length", encoding: "utf8-guaranteed" });
        expect(input.realmLiterals!.literals.filter((row) => row.encoding === "wtf16")).toEqual([
          { value: "", encoding: "wtf16" },
          { value: "length", encoding: "wtf16" },
        ]);
      }
      expect(planNativeRealmLiterals(r, utf8)).toBe(input.realmLiterals);
      expect(input.invocationRequirements!.source).toBe(r.source);
      expect(() => assertNativeStringValueReservationInput(input)).not.toThrow();
    });
  it("retains the automatically derived invocation when no optional issuers are supplied", () => {
    const program = source(),
      input = prepareNativeProgramStringInput(program, program.runtime[0]!, {})!;
    if ("kind" in input) throw Error(JSON.stringify(input));
    expect(input.invocationRequirements!.uses.length).toBeGreaterThan(0);
    expect(input.realmRequirements).toBeUndefined();
    expect(() => assertNativeStringValueReservationInput(input)).not.toThrow();
  });
  it("rejects copied, cross-program and wrong-encoding supplemental literal plans", () => {
    const a = selected(),
      b = selected(),
      literals = a.input.realmLiterals!;
    expect(() => requireNativeRealmLiteralPlan({ ...literals }, a.requirements, false)).toThrow(/copied/);
    expect(() => requireNativeRealmLiteralPlan(literals, b.requirements, false)).toThrow(/foreign/);
    expect(() => requireNativeRealmLiteralPlan(literals, a.requirements, true)).toThrow(/substituted/);
  });
  it.each([
    "missing-requirements",
    "missing-literals",
    "null",
    "accessor",
    "hidden",
    "inherited",
    "copy",
    "foreign",
  ] as const)("refuses %s pair before any physical reservation", (kind) => {
    const f = selected(),
      input = { ...f.input } as Record<string, unknown>;
    let calls = 0;
    if (kind === "missing-requirements") Reflect.deleteProperty(input, "realmRequirements");
    if (kind === "missing-literals") Reflect.deleteProperty(input, "realmLiterals");
    if (kind === "null") input.realmRequirements = null;
    if (kind === "accessor")
      Object.defineProperty(input, "realmRequirements", {
        enumerable: true,
        get: () => {
          calls++;
          return f.requirements;
        },
      });
    if (kind === "hidden")
      Object.defineProperty(input, "realmLiterals", { value: f.input.realmLiterals, enumerable: false });
    if (kind === "inherited") {
      Reflect.deleteProperty(input, "realmRequirements");
      Reflect.deleteProperty(input, "realmLiterals");
      Object.setPrototypeOf(input, { realmRequirements: f.requirements, realmLiterals: f.input.realmLiterals });
    }
    if (kind === "copy") input.realmLiterals = { ...f.input.realmLiterals };
    if (kind === "foreign") input.realmRequirements = selected().requirements;
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module),
      before = population(module);
    expect(() =>
      reserveNativeProgramFoundation(
        tx,
        f.vectorPlan,
        f.input.plan.literalRequirements,
        input as unknown as NativeStringValueReservationInput,
      ),
    ).toThrow();
    expect(population(module)).toEqual(before);
    expect(calls).toBe(0);
  });
  it("does not reinterpret ordinary absent supplemental fields as a selected realm", () => {
    expect(readNativeRealmLiteralInput({}, false)).toBeUndefined();
  });
  it("rejects a shortened literal declaration before allocation", () => {
    const f = selected(),
      module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const literals = {
      ...f.input.plan.literalRequirements,
      literals: f.input.plan.literalRequirements.literals.slice(1),
    };
    expect(() => reserveNativeProgramFoundation(tx, f.vectorPlan, literals, f.input)).toThrow(/declaration differs/);
    expect(population(module)).toEqual([0, 0, 0, 0]);
  });
  it.each(["foreign", "omitted-owner"] as const)("refuses the %s vector census before allocation", (kind) => {
    const f = selected(),
      module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const program = prepareGetterProgram("export function run(): number { return 2; }", false, "./foreign.ts");
    const projection = program.runtime[0]!;
    const foreign = deriveNativeVectorResourcePlan({
      anchor: program.inventory.sources.find((row) => row.kind === "entry")!.id,
      functions: program.ir.functions,
      abiEntries: program.abi.entries,
      policy: projection.prepared.manifest.policy,
      providers: projection.prepared.manifest.providers,
      backend: projection.backend,
      target: projection.target,
    });
    const plan = kind === "foreign" ? foreign : { ...f.vectorPlan, demands: f.vectorPlan.demands.slice(1) };
    if (kind === "omitted-owner") {
      expect(f.vectorPlan.demands.length).toBeGreaterThan(0);
      expect(plan.anchor).toBe(f.vectorPlan.anchor);
      expect(plan.layouts).toEqual(f.vectorPlan.layouts);
    }
    expect(() => reserveNativeProgramFoundation(tx, plan, f.input.plan.literalRequirements, f.input)).toThrow(
      /vector plan differs/,
    );
    expect(population(module)).toEqual([0, 0, 0, 0]);
  });
  it("accepts an equal vector description and rejects its later changed owner census", () => {
    const f = selected(),
      module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const plan = structuredClone(f.vectorPlan);
    const foundation = reserveNativeProgramFoundation(tx, plan, f.input.plan.literalRequirements, f.input);
    expect(foundation.realm).toBeDefined();
    expect(() => nativeRealmReservationInventory(tx, foundation.realm!)).toThrow(/incomplete realm reservation/);
    (plan.demands as unknown[]).pop();
    expect(() => nativeRealmReservationInventory(tx, foundation.realm!)).toThrow(/vector plan differs/);
  });
});
