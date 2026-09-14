// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import {
  deriveNativeValueResourcePlan,
  assertNativeValueResourcePlanFor,
} from "../src/ir/program/native-value-resources.js";
import {
  planNativeStringValuePhysical,
  type NativeStringValueReservationInput,
} from "../src/backend/wasmgc/program/native-string-values.js";
import { planPhysicalSetup, type PhysicalSetupPlan } from "../src/ir/program-physical-plan.js";
import { ProgramAbiMap, ProgramAbiInvariantError } from "../src/ir/program/abi.js";
import { preparedIrCallableSignature, preparedIrTypeKey } from "../src/ir/program-abi-contracts.js";
import { preparedIrRuntimeAbiAnchor, preparedIrRuntimeCallableBindingId } from "../src/ir/program-runtime-abi.js";
import { irSupportGlobalRef, irSourceTypeRef, irGlobalBindingKey, irTypeBindingKey } from "../src/ir/abi-bindings.js";
import { irSupportFuncRef, irRuntimeFuncRef, irCallableBindingKey } from "../src/ir/core/callable-bindings.js";
import { INTRINSIC_DEFINITIONS } from "../src/ir/core/intrinsics.js";
import { NUMBER_BOUNDARY_RUNTIME_PROVIDERS } from "../src/ir/runtime/manifest.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import type { IrFuncRef, IrGlobalRef } from "../src/ir/core/value-references.js";
import type { IrType, IrTypeRef } from "../src/ir/core/types.js";
import type { PreparedIrBackendOptions, PreparedIrProgram, PreparedIrAbiEntry } from "../src/ir/program.js";
import type { NativeStringValueDeclaration } from "../src/runtime/wasmgc/values/native-resource-declaration-types.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";

afterEach(async () => {
  await setImmediate();
});
const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  numberBoundary: { box: "unsupported", unbox: "native" },
} as const;
const options: PreparedIrBackendOptions = {
  backend: "wasmgc",
  target: "standalone",
  utf8Storage: false,
  sharedExceptionTag: false,
  sourceMap: false,
  moduleName: "native-string-abi-test",
};
const STRING: IrType = { kind: "string" };
const F64: IrType = { kind: "val", val: { kind: "f64" } };
const cache = new Map<string, PreparedIrProgram>();

function produced(value = " 42 ", numeric = true, duplicate = false): PreparedIrProgram {
  const key = JSON.stringify([value, numeric, duplicate]);
  const previous = cache.get(key);
  if (previous) return previous;
  const source = prepareIrProgramSources({
    ...sourceInput({
      "./entry.ts": numeric
        ? `function parse(s: string): number { return +s; } export function run(): number { return parse(${JSON.stringify(value)}); }`
        : `export function run(): string { return ${JSON.stringify(value)}; }${duplicate ? ` export function other(): string { return ${JSON.stringify(value)}; }` : ""}`,
    }),
    policy,
    nativeStringValueProjection: "standalone-native",
  });
  if (source.kind !== "prepared") throw new Error(source.detail);
  const program = requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(source), {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
    }),
  );
  assertPreparedIrProgram(program);
  cache.set(key, program);
  return program;
}

function nativeInput(program: PreparedIrProgram, utf8Storage = false): NativeStringValueReservationInput {
  const projection = program.runtime[0]!;
  const demands = collectNativeStringValueDemands(program, projection);
  const result = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage });
  if (result.kind !== "planned") throw new Error(`expected nonempty native plan, got ${result.kind}`);
  return {
    demands,
    plan: result.plan,
    ...(result.plan.mode === "number-boundary"
      ? { valueRequirements: deriveNativeValueResourcePlan(program, projection, "native-string") }
      : {}),
  };
}

function planned(
  program: PreparedIrProgram,
  utf8Storage = false,
  input = nativeInput(program, utf8Storage),
): PhysicalSetupPlan {
  const result = planPhysicalSetup(program, { ...options, utf8Storage }, program.runtime[0]!, input);
  expect(result.kind, result.kind === "planned" ? undefined : result.detail).toBe("planned");
  if (result.kind !== "planned") throw new Error(result.detail);
  expect(result.plan.nativeStrings).toBeDefined();
  return result.plan;
}

function role(plan: PhysicalSetupPlan, expected: readonly string[]): NativeStringValueDeclaration {
  const rows = plan.nativeStrings!.resources.declarations.filter(
    (row) => JSON.stringify(row.role) === JSON.stringify(expected),
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function binding(plan: PhysicalSetupPlan, declaration: NativeStringValueDeclaration) {
  const rows = plan.nativeStrings!.bindings.filter((row) => row.resourceKey === declaration.key);
  expect(rows.length).toBeGreaterThan(0);
  expect(new Set(rows.map((row) => row.entry.id)).size).toBe(1);
  return rows[0]!;
}

function nextOrder(program: PreparedIrProgram): number {
  const source = preparedIrRuntimeAbiAnchor(program.inventory);
  return (
    Math.max(
      -1,
      ...program.abi.entries
        .filter((row) => row.plan.order.sourceOrder === source.order)
        .map((row) => row.plan.order.declarationOrder),
    ) + 1
  );
}

function foreignSourceOwner(program: PreparedIrProgram) {
  const foreign = prepareIrProgramSources(sourceInput());
  if (foreign.kind !== "prepared") throw new Error(foreign.detail);
  const owner = foreign.inventory.sources.find(
    (source) => !program.inventory.sources.some((current) => current.id === source.id),
  );
  if (!owner) throw new Error("fixture requires an actual foreign source owner");
  return owner.id;
}

/** Explicit semantic ABI fixture additions over genuine source-produced bodies.
 * These are contract controls, not claims that the frontend already emits these references. */
function literalEntry(
  program: PreparedIrProgram,
  ref: IrFuncRef | IrGlobalRef,
  ordinal: number,
  type: IrType = STRING,
): PreparedIrAbiEntry {
  const order = { sourceOrder: preparedIrRuntimeAbiAnchor(program.inventory).order, declarationOrder: ordinal };
  if (ref.kind === "global")
    return {
      plan: {
        id: ref.binding.bindingId,
        order,
        displayName: ref.name,
        structuralReferenceKey: irGlobalBindingKey(ref.binding),
        slotPolicy: "required",
        slotSpace: "global",
        intent: { kind: "global", origin: "support", valueType: preparedIrTypeKey(type), mutable: false },
      },
      contract: { kind: "global", ref, type, mutable: false },
    };
  if (ref.binding.kind !== "support") throw new Error("fixture needs canonical support ref");
  return {
    plan: {
      id: ref.binding.bindingId,
      order,
      displayName: ref.name,
      structuralReferenceKey: irCallableBindingKey(ref.binding),
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "support",
        sourceId: preparedIrRuntimeAbiAnchor(program.inventory).id,
        signature: preparedIrCallableSignature([], [type]),
      },
    },
    contract: { kind: "callable", ref, params: [], results: [type] },
  };
}

function referenced(
  program: PreparedIrProgram,
  refs: readonly (IrFuncRef | IrGlobalRef)[],
  entries: readonly PreparedIrAbiEntry[],
): PreparedIrProgram {
  const rewrite = (functions: PreparedIrProgram["ir"]["functions"]) =>
    functions.map((fn, index) => ({
      ...fn,
      blocks: fn.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instruction) => {
          if (instruction.kind !== "string.const") return instruction;
          const ref = refs[index % refs.length]!;
          return { ...instruction, ...(ref.kind === "global" ? { storage: ref } : { materializer: ref }) };
        }),
      })),
    }));
  const result = {
    ...program,
    abi: { entries: [...program.abi.entries, ...entries] },
    ir: { ...program.ir, functions: rewrite(program.ir.functions) },
    runtime: program.runtime.map((projection) => ({
      ...projection,
      prepared: {
        ...projection.prepared,
        functions: rewrite(projection.prepared.functions),
      },
    })),
  };
  // Real canonical codec reauthentication; no mock of any validator or producer.
  return decodePreparedIrProgram(encodePreparedIrProgram(result));
}

describe("source-produced native ABI plans, without allocation or consumer execution", () => {
  for (const utf8 of [false, true])
    for (const replay of [false, true])
      for (const numeric of [false, true]) {
        it(`plans complete native resources, numeric=${numeric}, utf8=${utf8}, decoded=${replay}`, () => {
          const original = produced(" 42 ", numeric);
          const program = replay ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
          const bytes = encodePreparedIrProgram(program),
            input = nativeInput(program, utf8);
          const plan = planned(program, utf8, input),
            native = plan.nativeStrings!;
          expect(new Set(native.bindings.map((row) => row.resourceKey))).toEqual(
            new Set(native.resources.declarations.map((row) => row.key)),
          );
          expect(native.bindings.length).toBe(native.resources.declarations.length);
          expect(native.resources.mode).toBe(numeric ? "number-boundary" : "literals");
          expect(native.resources.literalUses.length).toBeGreaterThan(0);
          expect(plan.functions.map((row) => row.unitId)).toEqual(program.ir.functions.map((row) => row.unitId));
          expect(plan.functions.flatMap((row) => [...row.params, ...row.results])).toContainEqual({ kind: "string" });
          for (const [index, declaration] of native.resources.declarations.entries()) {
            const row = binding(plan, declaration);
            expect(row.entry.slotPolicy).toBe("required");
            expect(row.entry.slotSpace).toBe(declaration.space);
            expect(row.entry.intent.kind).toBe(declaration.space === "function" ? "callable" : declaration.space);
            expect(row.entry.order).toEqual({
              sourceOrder: preparedIrRuntimeAbiAnchor(program.inventory).order,
              declarationOrder: nextOrder(program) + index,
            });
          }
          const abi = new ProgramAbiMap(program.inventory, program.derivedUnits);
          for (const row of program.abi.entries) abi.plan(row.plan);
          for (const row of native.bindings) abi.plan(row.entry);
          abi.sealPlan();
          expect(abi.entries().length).toBe(program.abi.entries.length + native.bindings.length);
          expect(encodePreparedIrProgram(program)).toBe(bytes);
          expect(Object.isFrozen(native.resources.declarations)).toBe(true);
          expect(Object.isFrozen(native.bindings)).toBe(true);
          expect(Object.hasOwn(native, "valueRequirements")).toBe(false);
          expect(Object.hasOwn(plan, "demands")).toBe(false);
          if (input.valueRequirements) {
            expect(() =>
              assertNativeValueResourcePlanFor(input.valueRequirements!, program, program.runtime[0]!, "native-string"),
            ).not.toThrow();
          }
        });
      }

  it("keeps no-demand setup shape and complete original ABI unchanged", () => {
    const source = prepareIrProgramSources(sourceInput());
    if (source.kind !== "prepared") throw new Error(source.detail);
    const program = requireProgram(prepareTypedIrProgram(captureTypedIrProgramInput(source), typedOptions));
    const before = encodePreparedIrProgram(program),
      projection = program.runtime[0]!;
    const without = planPhysicalSetup(program, options, projection);
    expect(without.kind).toBe("planned");
    expect(planPhysicalSetup(program, options, projection, undefined)).toEqual(without);
    if (without.kind !== "planned") throw new Error(without.detail);
    expect(Object.hasOwn(without.plan, "nativeStrings")).toBe(false);
    expect(encodePreparedIrProgram(program)).toBe(before);
    expect(
      planNativeStringValuePhysical(collectNativeStringValueDemands(program, projection), {
        representation: "native-string",
        utf8Storage: false,
      }),
    ).toEqual({ kind: "none" });
  });

  it("retains the old located refusal when native planning is omitted", () => {
    const program = produced();
    expect(planned(program).nativeStrings).toBeDefined();
    const old = planPhysicalSetup(program, options, program.runtime[0]!);
    expect(old).toMatchObject({ kind: "unsupported", code: "body-shape-rejected", stage: "build" });
    if (old.kind === "planned") throw new Error("expected historical refusal");
    expect(old.detail).toMatch(/string|provider materialization/);
    expect(old.sourceFile).toBeTruthy();
    expect(old.location.line).toBeGreaterThan(0);
    expect(old.unitId).toBeTruthy();
  });

  it("pins native unbox to selected canonical provider; internal box is not intrinsic admission", () => {
    const program = produced(),
      plan = planned(program);
    const canonical = NUMBER_BOUNDARY_RUNTIME_PROVIDERS.find((row) => row.id === "native.js.number.unbox")!;
    expect(canonical.implementation.kind).toBe("runtime-callable");
    if (canonical.implementation.kind !== "runtime-callable") throw new Error("canonical native provider changed");
    const ref = irRuntimeFuncRef(canonical.implementation.symbol),
      row = binding(plan, role(plan, ["values", "unbox-number"]));
    expect(program.runtime[0]!.prepared.providers.get("js.number.unbox")).toEqual(canonical);
    expect(row.reference).toEqual(ref);
    expect(row.entry.id).toBe(preparedIrRuntimeCallableBindingId(program.inventory, ref));
    expect(row.entry.intent).toEqual({
      kind: "callable",
      origin: "runtime",
      signature: preparedIrCallableSignature(INTRINSIC_DEFINITIONS["js.number.unbox"].signature.params, [
        INTRINSIC_DEFINITIONS["js.number.unbox"].signature.result,
      ]),
    });
    expect(irRuntimeCallableDeclaration(ref)).toBeUndefined();
    expect(program.abi.entries.some((entry) => entry.plan.id === row.entry.id)).toBe(false);
    const box = binding(plan, role(plan, ["values", "box-number"]));
    expect(box.reference.binding.kind).toBe("support");
    expect(box.entry.intent).toMatchObject({
      kind: "callable",
      origin: "support",
      sourceId: preparedIrRuntimeAbiAnchor(program.inventory).id,
    });
    expect(program.runtime[0]!.prepared.providers.has("js.number.box")).toBe(false);
  });

  it.each(["oversized-literal", "number-boundary"] as const)(
    "requires the exact entry-source owner on every genuine %s support callable",
    (mode) => {
      const program = mode === "oversized-literal" ? produced("q".repeat(10001), false) : produced();
      const native = planned(program).nativeStrings!,
        anchor = preparedIrRuntimeAbiAnchor(program.inventory),
        foreignOwner = foreignSourceOwner(program);
      const support = native.bindings.filter(
        (row) => row.entry.intent.kind === "callable" && row.entry.intent.origin === "support",
      );
      expect(support.length).toBeGreaterThan(0);
      for (const row of support) {
        if (row.entry.intent.kind !== "callable" || row.entry.intent.origin !== "support")
          throw new Error("expected support callable");
        expect(row.entry.intent.sourceId).toBe(anchor.id);
        expect(Object.hasOwn(row.entry.intent, "unitId")).toBe(false);
        expect(Object.hasOwn(row.entry.intent, "classId")).toBe(false);
        const valid = new ProgramAbiMap(program.inventory, program.derivedUnits);
        for (const entry of program.abi.entries) valid.plan(entry.plan);
        for (const entry of native.bindings) valid.plan(entry.entry);
        expect(() => valid.sealPlan()).not.toThrow();

        const { sourceId: removedOwner, ...ownerless } = row.entry.intent;
        expect(removedOwner).toBe(anchor.id);
        for (const change of ["missing", "foreign"] as const) {
          const invalid = new ProgramAbiMap(program.inventory, program.derivedUnits);
          for (const entry of program.abi.entries) invalid.plan(entry.plan);
          let caught: unknown;
          try {
            invalid.plan({
              ...row.entry,
              intent: change === "missing" ? ownerless : { ...ownerless, sourceId: foreignOwner },
            });
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(ProgramAbiInvariantError);
          expect(caught).toMatchObject({
            code: change === "missing" ? "invalid-callable-provenance" : "unknown-draft-source",
            message: expect.stringContaining(
              change === "missing"
                ? "must identify exactly one unit, class, or source owner"
                : "outside this inventory",
            ),
          });
        }
      }
      for (const row of native.bindings) {
        if (row.entry.intent.kind !== "callable" || row.entry.intent.origin === "runtime") {
          expect(Object.hasOwn(row.entry.intent, "sourceId")).toBe(false);
        }
      }
    },
  );

  it.each([false, true])("includes private chunks, interning and distinct empty encodings, utf8=%s", (utf8) => {
    const plan = planned(produced("x".repeat(20001)), utf8),
      resources = plan.nativeStrings!.resources;
    expect(resources.declarations.filter((row) => row.role[0] === "literal-materializer")).toHaveLength(1);
    expect(resources.declarations.filter((row) => row.role[0] === "literal-global")).toHaveLength(3);
    expect(resources.declarations.some((row) => row.role[1] === "u16:")).toBe(true);
    expect(resources.reservationSteps.filter((row) => row.kind === "intern-signature")).toHaveLength(3);
    expect(
      resources.declarations.filter((row) => row.space === "type").every((row) => row.role[0] !== "signature"),
    ).toBe(true);
    const empty = planned(produced(""), utf8).nativeStrings!.resources;
    const empties = empty.declarations.filter((row) => row.role[0] === "literal-global");
    expect(empties.map((row) => row.role[1])).toEqual(utf8 ? ["u8:", "u16:"] : ["u16:"]);
  });
});

describe("existing semantic string ABI joins (explicit contract fixtures)", () => {
  it.each([false, true])(
    "reuses immutable semantic string storage separately from physical layout, utf8=%s",
    (utf8) => {
      const base = produced("hello", false),
        ref = irSupportGlobalRef(preparedIrRuntimeAbiAnchor(base.inventory).id, "fixture-literal", "diagnostic");
      const entry = literalEntry(base, ref, nextOrder(base)),
        program = referenced(base, [ref], [entry]);
      const bytes = encodePreparedIrProgram(program),
        plan = planned(program, utf8);
      const declaration = role(plan, ["literal-global", (utf8 ? "u8:" : "u16:") + "hello"]);
      expect(declaration).toMatchObject({ space: "global", mutable: false, valueType: { kind: "ref" } });
      expect(binding(plan, declaration).entry).toEqual(entry.plan);
      expect(binding(plan, declaration).entry.intent).toMatchObject({
        kind: "global",
        valueType: preparedIrTypeKey(STRING),
      });
      expect(encodePreparedIrProgram(program)).toBe(bytes);
      const reusedIndex = plan.nativeStrings!.resources.declarations.indexOf(declaration);
      for (const [index, row] of plan.nativeStrings!.resources.declarations.entries())
        if (index !== reusedIndex)
          expect(binding(plan, row).entry.order.declarationOrder).toBe(nextOrder(program) + index);
    },
  );

  it("retains both existing aliases and the one canonical required root", () => {
    const base = produced("alias", false, true),
      anchor = preparedIrRuntimeAbiAnchor(base.inventory).id;
    const refs = ["root", "alias-a", "alias-b"].map((key) => irSupportGlobalRef(anchor, key, "same diagnostic"));
    const entries = refs.map((ref, index) => literalEntry(base, ref, nextOrder(base) + index));
    const root = entries[0]!;
    const aliases = entries.slice(1).map(
      (entry, index): PreparedIrAbiEntry => ({
        ...entry,
        plan: {
          id: entry.plan.id,
          order: entry.plan.order,
          displayName: entry.plan.displayName,
          structuralReferenceKey: entry.plan.structuralReferenceKey,
          intent: { kind: "global", origin: "support", valueType: preparedIrTypeKey(STRING), mutable: false },
          slotPolicy: "alias",
          aliasOf: index === 0 ? root.plan.id : entries[1]!.plan.id,
        },
      }),
    );
    const program = referenced(base, refs.slice(1), [root, ...aliases]),
      plan = planned(program);
    const declaration = role(plan, ["literal-global", "u16:alias"]);
    const rows = plan.nativeStrings!.bindings.filter((row) => row.resourceKey === declaration.key);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.entry.id))).toEqual(new Set([root.plan.id]));
    expect(
      new Set(
        rows.map((row) => (row.reference.kind === "global" ? irGlobalBindingKey(row.reference.binding) : "wrong")),
      ),
    ).toEqual(new Set(refs.map((ref) => irGlobalBindingKey(ref.binding))));
    expect(program.abi.entries.slice(-3).map((row) => row.plan)).toEqual([root, ...aliases].map((row) => row.plan));
  });

  it("reuses a zero-parameter semantic string materializer, not its physical ref key", () => {
    const base = produced("y".repeat(10001), false),
      ref = irSupportFuncRef(preparedIrRuntimeAbiAnchor(base.inventory).id, "oversized", "materializer");
    const entry = literalEntry(base, ref, nextOrder(base)),
      program = referenced(base, [ref], [entry]);
    const plan = planned(program),
      declaration = plan.nativeStrings!.resources.declarations.find((row) => row.role[0] === "literal-materializer")!;
    expect(binding(plan, declaration)).toMatchObject({ entry: entry.plan, reference: ref });
    expect(declaration).toMatchObject({ signature: { params: [], results: [{ kind: "ref" }] } });
    expect(entry.plan.intent).toMatchObject({
      sourceId: preparedIrRuntimeAbiAnchor(base.inventory).id,
      signature: preparedIrCallableSignature([], [STRING]),
    });
  });

  it.each(["missing", "foreign"] as const)(
    "rejects a %s explicit materializer owner after genuine positive",
    (change) => {
      const base = produced("y".repeat(10001), false),
        anchor = preparedIrRuntimeAbiAnchor(base.inventory),
        ref = irSupportFuncRef(anchor.id, "oversized", "materializer");
      const entry = literalEntry(base, ref, nextOrder(base));
      expect(planned(referenced(base, [ref], [entry])).nativeStrings).toBeDefined();
      if (entry.plan.intent.kind !== "callable") throw new Error("expected support callable");
      const { sourceId: owner, ...ownerless } = entry.plan.intent;
      expect(owner).toBe(anchor.id);
      const abi = new ProgramAbiMap(base.inventory, base.derivedUnits);
      for (const original of base.abi.entries) abi.plan(original.plan);
      let caught: unknown;
      try {
        abi.plan({
          ...entry.plan,
          intent: change === "missing" ? ownerless : { ...ownerless, sourceId: foreignSourceOwner(base) },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProgramAbiInvariantError);
      expect(caught).toMatchObject({
        code: change === "missing" ? "invalid-callable-provenance" : "unknown-draft-source",
        message: expect.stringContaining(
          change === "missing" ? "must identify exactly one unit, class, or source owner" : "outside this inventory",
        ),
      });
    },
  );

  it("rejects two independent required roots for one interned literal", () => {
    const base = produced("shared", false, true),
      anchor = preparedIrRuntimeAbiAnchor(base.inventory).id;
    const refs = ["one", "two"].map((name) => irSupportGlobalRef(anchor, name, name));
    const entries = refs.map((ref, index) => literalEntry(base, ref, nextOrder(base) + index));
    expect(planned(referenced(base, [refs[0]!], [entries[0]!])).nativeStrings).toBeDefined();
    const program = referenced(base, refs, entries);
    expect(() => planned(program)).toThrow(/independent required roots/);
  });

  it("requires an explicit AnyString type join for an attached carrier", () => {
    const base = produced("carrier", false),
      anchor = preparedIrRuntimeAbiAnchor(base.inventory);
    const ref = irSupportGlobalRef(anchor.id, "carrier-literal", "literal");
    const carrier = irSourceTypeRef(
      anchor.id,
      'native-string-values:v1:["string-type","any"]',
      "AnyString semantic carrier",
    );
    const type: IrType = { kind: "string", carrierRef: carrier };
    const literal = literalEntry(base, ref, nextOrder(base), type);
    const typeEntry: PreparedIrAbiEntry = {
      plan: {
        id: carrier.binding.bindingId,
        order: { sourceOrder: anchor.order, declarationOrder: nextOrder(base) + 1 },
        displayName: carrier.name,
        structuralReferenceKey: irTypeBindingKey(carrier.binding),
        slotPolicy: "required",
        slotSpace: "type",
        intent: { kind: "type", shapeKey: preparedIrTypeKey(STRING) },
      },
      contract: { kind: "type", ref: carrier, type: STRING },
    };
    expect(planned(referenced(base, [ref], [literal, typeEntry])).nativeStrings).toBeDefined();
    expect(() => planned(referenced(base, [ref], [literal]))).toThrow();
    const foreign: IrTypeRef = irSourceTypeRef(anchor.id, "unrelated", "AnyString semantic carrier");
    expect(() =>
      planned(
        referenced(
          base,
          [ref],
          [literalEntry(base, ref, nextOrder(base), { kind: "string", carrierRef: foreign }), typeEntry],
        ),
      ),
    ).toThrow();
  });
});

describe("positive-first ABI and selected-provider countermodels", () => {
  it.each(["missing", "mutable", "numeric", "slotless", "wrong-payload", "order-overflow"] as const)(
    "rejects %s existing global entry rather than replacing its identity",
    (change) => {
      const base = produced("guard", false),
        ref = irSupportGlobalRef(preparedIrRuntimeAbiAnchor(base.inventory).id, "guard", "guard");
      const entry = literalEntry(base, ref, nextOrder(base));
      expect(planned(referenced(base, [ref], [entry])).nativeStrings).toBeDefined();
      if (entry.plan.intent.kind !== "global") throw new Error("fixture requires a global intent");
      let entries = [entry];
      if (change === "missing") entries = [];
      if (change === "mutable") {
        if (entry.plan.intent.kind !== "global" || entry.contract.kind !== "global")
          throw new Error("fixture global missing");
        entries = [
          {
            plan: { ...entry.plan, intent: { ...entry.plan.intent, mutable: true } },
            contract: { ...entry.contract, mutable: true },
          },
        ];
      }
      if (change === "numeric") entries = [literalEntry(base, ref, nextOrder(base), F64)];
      if (change === "slotless")
        entries = [
          {
            ...entry,
            plan: {
              id: entry.plan.id,
              order: entry.plan.order,
              displayName: entry.plan.displayName,
              structuralReferenceKey: entry.plan.structuralReferenceKey,
              intent: entry.plan.intent,
              slotPolicy: "none",
            },
          },
        ];
      if (change === "wrong-payload")
        entries = [{ ...entry, plan: { ...entry.plan, structuralReferenceKey: "unrelated" } }];
      if (change === "order-overflow")
        entries = [
          {
            ...entry,
            plan: { ...entry.plan, order: { ...entry.plan.order, declarationOrder: Number.MAX_SAFE_INTEGER } },
          },
        ];
      expect(() => planned(referenced(base, [ref], entries))).toThrow();
    },
  );

  it.each(["arity", "result", "promise", "wrong-realization"] as const)(
    "rejects %s materializer contracts",
    (change) => {
      const base = produced("z".repeat(10001), false),
        ref = irSupportFuncRef(
          preparedIrRuntimeAbiAnchor(base.inventory).id,
          "guard-materializer",
          "guard-materializer",
        );
      const entry = literalEntry(base, ref, nextOrder(base));
      expect(planned(referenced(base, [ref], [entry])).nativeStrings).toBeDefined();
      if (entry.contract.kind !== "callable" || entry.plan.intent.kind !== "callable")
        throw new Error("missing callable fixture");
      const params = change === "arity" ? [F64] : [];
      const results = change === "result" ? [F64] : [STRING];
      let changed: PreparedIrAbiEntry = {
        ...entry,
        contract: { ...entry.contract, params, results },
        plan: {
          ...entry.plan,
          intent: { ...entry.plan.intent, signature: preparedIrCallableSignature(params, results) },
        },
      };
      if (change === "promise") {
        // Even an own undefined Promise attachment is not an absent synchronous contract.
        changed = { ...changed, contract: { ...entry.contract, promise: undefined } };
      }
      expect(() =>
        planned(referenced(change === "wrong-realization" ? produced("short", false) : base, [ref], [changed])),
      ).toThrow();
    },
  );

  it.each(["delete", "extra", "reorder", "field", "parent-presence", "signature", "nullable", "reference"] as const)(
    "rejects %s declaration changes before any ABI/resource allocation",
    (change) => {
      const program = produced(),
        input = nativeInput(program);
      expect(planned(program, false, input).nativeStrings).toBeDefined();
      const declarations = [...input.plan.declarations];
      if (change === "delete") declarations.pop();
      else if (change === "extra") declarations.push({ ...declarations[0]!, key: "extra-declaration" });
      else if (change === "reorder") declarations.reverse();
      else {
        const index = declarations.findIndex((row) =>
          change === "signature" ? row.space === "function" : row.space === "type" && row.shape.kind === "struct",
        );
        const row = declarations[index]!;
        if (row.space === "function") {
          const signature = { ...row.signature, params: [...row.signature.params, { kind: "i32" as const }] };
          expect(signature.params).toHaveLength(row.signature.params.length + 1);
          expect(signature).not.toStrictEqual(row.signature);
          declarations[index] = { ...row, signature };
        } else if (row.space === "type" && row.shape.kind === "struct") {
          const fields = [...row.shape.fields];
          if (change === "field") fields[0] = { ...fields[0]!, mutable: !fields[0]!.mutable };
          if (change === "nullable")
            fields[0] = { ...fields[0]!, type: { kind: "ref_null", typeKey: declarations[0]!.key } };
          if (change === "reference") fields[0] = { ...fields[0]!, type: { kind: "ref", typeKey: "foreign-key" } };
          declarations[index] = {
            ...row,
            shape: { ...row.shape, fields, ...(change === "parent-presence" ? { parent: undefined } : {}) },
          };
        } else throw new Error("expected independent declaration mutation target");
      }
      expect(declarations).not.toStrictEqual(input.plan.declarations);
      expect(() => planned(program, false, { ...input, plan: { ...input.plan, declarations } })).toThrow(/changed/);
    },
  );

  it.each([
    "foreign-program",
    "foreign-projection",
    "copied-issued",
    "wrong-issued-source",
    "missing-issued",
    "wrong-utf8",
    "removed-use",
  ] as const)("rejects %s native reservation input", (change) => {
    const program = produced(),
      input = nativeInput(program);
    expect(planned(program, false, input).nativeStrings).toBeDefined();
    let changed: NativeStringValueReservationInput = input;
    if (change === "foreign-program")
      changed = { ...input, demands: { ...input.demands, program: produced("different") } };
    if (change === "foreign-projection")
      changed = { ...input, demands: { ...input.demands, projection: { ...program.runtime[0]! } } };
    if (change === "copied-issued") changed = { ...input, valueRequirements: { ...input.valueRequirements! } };
    if (change === "wrong-issued-source") {
      const foreign = decodePreparedIrProgram(encodePreparedIrProgram(program));
      changed = {
        ...input,
        valueRequirements: deriveNativeValueResourcePlan(foreign, foreign.runtime[0]!, "native-string"),
      };
    }
    if (change === "missing-issued") changed = { demands: input.demands, plan: input.plan };
    if (change === "wrong-utf8")
      changed = {
        ...input,
        plan: { ...input.plan, literalRequirements: { ...input.plan.literalRequirements, utf8Storage: true } },
      };
    if (change === "removed-use") changed = { ...input, plan: { ...input.plan, literalUses: [] } };
    expect(() => planned(program, false, changed)).toThrow();
  });

  it.each([
    "policy",
    "manifest",
    "duplicate-provider",
    "map-missing",
    "map-substituted",
    "attachment",
    "signature",
  ] as const)("rejects an independently changed %s in the real selected unbox projection", (change) => {
    const program = produced();
    expect(planned(program).nativeStrings).toBeDefined();
    const old = program.runtime[0]!,
      runtime = old.prepared,
      manifest = runtime.manifest;
    const canonical = runtime.providers.get("js.number.unbox")!;
    const providers = new Map(runtime.providers);
    if (change === "map-missing") providers.delete("js.number.unbox");
    if (change === "map-substituted")
      providers.set("js.number.unbox", {
        ...canonical,
        implementation: { kind: "runtime-callable", symbol: "foreign" },
      });
    const altered = {
      ...old,
      prepared: {
        ...runtime,
        providers,
        manifest: {
          ...manifest,
          ...(change === "policy"
            ? {
                policy: {
                  ...manifest.policy,
                  numberBoundary: { ...manifest.policy.numberBoundary, unbox: "unsupported" as const },
                },
              }
            : {}),
          ...(change === "manifest" ? { providers: manifest.providers.filter((row) => row.id !== canonical.id) } : {}),
          ...(change === "duplicate-provider" ? { providers: [...manifest.providers, canonical] } : {}),
          ...(change === "signature"
            ? {
                providers: manifest.providers.map((row) =>
                  row.id === canonical.id
                    ? { ...row, signature: { ...canonical.signature!, result: F64, params: [F64] } }
                    : row,
                ),
              }
            : {}),
        },
        functions:
          change === "attachment"
            ? runtime.functions.map((fn) => ({
                ...fn,
                blocks: fn.blocks.map((block) => ({
                  ...block,
                  instrs: block.instrs.map((instruction) =>
                    instruction.kind === "intrinsic" && instruction.id === "js.number.unbox"
                      ? { ...instruction, provider: { kind: "callable" as const, target: irRuntimeFuncRef("foreign") } }
                      : instruction,
                  ),
                })),
              }))
            : runtime.functions,
      },
    };
    const changed: PreparedIrProgram = { ...program, runtime: [altered] };
    expect(() => planned(changed)).toThrow();
  });

  it("does not reinterpret a raw reference index as a semantic string", () => {
    const base = produced("index", false),
      ref = irSupportGlobalRef(preparedIrRuntimeAbiAnchor(base.inventory).id, "index", "index");
    expect(planned(referenced(base, [ref], [literalEntry(base, ref, nextOrder(base))])).nativeStrings).toBeDefined();
    const entry = literalEntry(base, ref, nextOrder(base), { kind: "val", val: { kind: "ref", typeIdx: 0 } });
    expect(() => planned(referenced(base, [ref], [entry]))).toThrow();
  });

  it.each(["missing-target", "cycle", "different-contract"] as const)("rejects %s literal aliases", (change) => {
    const base = produced("alias-negative", false),
      anchor = preparedIrRuntimeAbiAnchor(base.inventory).id;
    const rootRef = irSupportGlobalRef(anchor, "alias-root", "literal"),
      aliasRef = irSupportGlobalRef(anchor, "alias", "literal");
    const root = literalEntry(base, rootRef, nextOrder(base)),
      alias = literalEntry(base, aliasRef, nextOrder(base) + 1);
    if (alias.contract.kind !== "global") throw new Error("fixture needs global");
    const valid: PreparedIrAbiEntry = {
      ...alias,
      plan: {
        id: alias.plan.id,
        order: alias.plan.order,
        displayName: alias.plan.displayName,
        structuralReferenceKey: alias.plan.structuralReferenceKey,
        slotPolicy: "alias",
        aliasOf: root.plan.id,
        intent: { kind: "global", origin: "support", valueType: preparedIrTypeKey(STRING), mutable: false },
      },
    };
    expect(planned(referenced(base, [aliasRef], [root, valid])).nativeStrings).toBeDefined();
    if (valid.plan.slotPolicy !== "alias" || valid.plan.intent.kind !== "global")
      throw new Error("fixture needs global alias");
    const invalid: PreparedIrAbiEntry = {
      ...valid,
      plan: {
        ...valid.plan,
        aliasOf:
          change === "cycle"
            ? valid.plan.id
            : change === "missing-target"
              ? irSupportGlobalRef(anchor, "missing", "literal").binding.bindingId
              : root.plan.id,
        intent: { ...valid.plan.intent, mutable: change === "different-contract" },
      },
      contract: { ...alias.contract, mutable: change === "different-contract" },
    };
    expect(() => planned(referenced(base, [aliasRef], [root, invalid]))).toThrow();
  });

  it.each([
    { ...options, backend: "linear" as const },
    { ...options, target: "host" as const },
  ])("rejects a native input under mismatched backend/target $backend:$target", (otherOptions) => {
    const program = produced(),
      input = nativeInput(program);
    expect(planned(program, false, input).nativeStrings).toBeDefined();
    expect(() => planPhysicalSetup(program, otherOptions, program.runtime[0]!, input)).toThrow();
  });
});
