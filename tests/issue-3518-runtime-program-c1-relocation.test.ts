// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { createDerivedIrUnitId, createIrBindingId } from "../src/shared/contracts/identity-values.js";
import { preparedIrProgramOwner as oldOwner } from "../src/ir/program.js";
import { preparedIrProgramOwner } from "../src/ir/program/owner.js";
import { preparedIrDraftAbiLookup as oldDraft } from "../src/ir/program-abi-contracts.js";
import { preparedIrDraftAbiLookup } from "../src/ir/program/draft-abi-lookup.js";
import { assertPreparedIrRuntimeSupportDependencies as oldSupportProof } from "../src/ir/prepared-component-dependencies.js";
import { assertPreparedIrRuntimeSupportDependencies } from "../src/ir/program/runtime-support-dependencies.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import type { ProgramAbiDerivedUnitRecord } from "../src/ir/program/abi.js";
import type { PreparedIrAbiEntry, PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import type { IrRuntimeSupport } from "../src/ir/program/runtime-support.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareNumberFormatRuntimeSupport } from "../src/frontend/builtins/prepare-number-format.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import * as oldGenerator from "../src/ir/generator-support.js";
import * as generator from "../src/ir/runtime/generator-support.js";
import { irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { asBlockId, asValueId, type IrInstr } from "../src/ir/core/nodes.js";
import { irVal, type IrType } from "../src/ir/core/types.js";
import { irSupportTypeRef } from "../src/ir/core/type-references.js";
import type { PreparedIrFunction } from "../src/ir/runtime/contracts/prepared.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

// These controls read actual current modules and their types. Historical source
// reconstruction is a separate root-owned proof, never a substitute for them.
describe("Phase C1 current public API identities", () => {
  it("forwards the three partial extractions as the same function objects", () => {
    expect(oldOwner).toBe(preparedIrProgramOwner);
    expect(oldDraft).toBe(preparedIrDraftAbiLookup);
    expect(oldSupportProof).toBe(assertPreparedIrRuntimeSupportDependencies);
  });

  it.each([
    "irGeneratorPushProviderSymbol",
    "irGeneratorSetReturnNeedsBoxing",
    "forEachIrGeneratorSetReturn",
    "irGeneratorNumberBoxDemand",
    "attachIrGeneratorSupport",
    "collectAttachedGeneratorProviders",
  ] as const)("forwards the exact generator function object: %s", (name) => {
    expect(oldGenerator[name]).toBe(generator[name]);
  });

  it("retains the complete prepared-function parameter and return API", () => {
    expectTypeOf<Parameters<typeof generator.attachIrGeneratorSupport>[0]>().toEqualTypeOf<PreparedIrFunction>();
    expectTypeOf<ReturnType<typeof generator.attachIrGeneratorSupport>>().toEqualTypeOf<PreparedIrFunction>();
    expectTypeOf<Parameters<typeof generator.forEachIrGeneratorSetReturn>[0]>().toEqualTypeOf<PreparedIrFunction>();
    expectTypeOf<Parameters<typeof generator.irGeneratorNumberBoxDemand>[0]>().toEqualTypeOf<
      readonly PreparedIrFunction[]
    >();
    expectTypeOf<Parameters<typeof generator.collectAttachedGeneratorProviders>[0]>().toEqualTypeOf<
      readonly PreparedIrFunction[]
    >();
    expectTypeOf<typeof oldGenerator.attachIrGeneratorSupport>().toEqualTypeOf<
      typeof generator.attachIrGeneratorSupport
    >();
  });
});

function ownerInput() {
  const source = ts.createSourceFile(
    "/repo/c1-owner.ts",
    "export function original() { return () => 42; }\nexport function other() { return 7; }",
    ts.ScriptTarget.Latest,
    true,
  );
  const inventory = buildIrUnitInventory([source], { entrySource: source });
  return { inventory, derivedUnits: [] as ProgramAbiDerivedUnitRecord[] };
}

describe("Phase C1 diagnostic owner", () => {
  it("returns the original terminal's exact source key and freezes both evidence levels", () => {
    const input = ownerInput();
    const terminal = input.inventory.terminalUnits[0]!;
    const owner = preparedIrProgramOwner(input, terminal.id)!;
    expect(owner).toEqual({
      unitId: terminal.id,
      sourceFile: input.inventory.sources[0]!.sourceKey,
      location: {
        sourceId: terminal.sourceId,
        line: terminal.line,
        column: terminal.column,
        declarationStart: terminal.declarationStart,
        declarationEnd: terminal.declarationEnd,
      },
    });
    expect(Object.isFrozen(owner)).toBe(true);
    expect(Object.isFrozen(owner.location)).toBe(true);
  });

  it("resolves an actual inventoried lifted arrow through its terminal owner", () => {
    const input = ownerInput();
    const arrow = input.inventory.allUnits.find((unit) => unit.kind === "arrow-function")!;
    expect(arrow.terminalOwnerId).not.toBeNull();
    expect(preparedIrProgramOwner(input, arrow.id)).toEqual(preparedIrProgramOwner(input, arrow.terminalOwnerId!));
  });

  it("joins a canonical derived record to the terminal's source location", () => {
    const input = ownerInput();
    const terminal = input.inventory.terminalUnits[0]!;
    const provenance: ProgramAbiDerivedUnitRecord = {
      id: createDerivedIrUnitId({ parentId: terminal.id, role: "ir-async-state", ordinal: 0 }),
      parentId: terminal.id,
      terminalOwnerId: terminal.id,
      sourceId: terminal.sourceId,
      role: "ir-async-state",
      ordinal: 0,
    };
    const derived = preparedIrProgramOwner({ ...input, derivedUnits: [provenance] }, provenance.id)!;
    expect(derived).toEqual(preparedIrProgramOwner(input, terminal.id));
    expect(Object.isFrozen(derived)).toBe(true);
    expect(Object.isFrozen(derived.location)).toBe(true);
  });

  it("keeps derived-before-inventory precedence and nullish fallback", () => {
    const input = ownerInput();
    const [first, second] = input.inventory.terminalUnits;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const overlap: ProgramAbiDerivedUnitRecord = {
      id: first!.id,
      parentId: second!.id,
      terminalOwnerId: second!.id,
      sourceId: second!.sourceId,
      role: "ir-async-state",
      ordinal: 0,
    };
    expect(preparedIrProgramOwner({ ...input, derivedUnits: [overlap] }, first!.id)).toEqual(
      preparedIrProgramOwner(input, second!.id),
    );
    expect(
      preparedIrProgramOwner({ ...input, derivedUnits: [{ ...overlap, terminalOwnerId: null }] }, first!.id),
    ).toEqual(preparedIrProgramOwner(input, first!.id));
  });

  it("preserves undefined for an unknown terminal or a missing source record", () => {
    const input = ownerInput();
    const terminal = input.inventory.terminalUnits[0]!;
    const unknown = createDerivedIrUnitId({ parentId: terminal.id, role: "ir-async-state", ordinal: 99 });
    expect(preparedIrProgramOwner(input, unknown)).toBeUndefined();
    expect(
      preparedIrProgramOwner({ ...input, inventory: { ...input.inventory, sources: [] } }, terminal.id),
    ).toBeUndefined();
  });
});

const nativePolicy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
let program: PreparedIrProgram;

beforeAll(() => {
  // The same genuine source and formatter producer used by the existing
  // transport controls. Build once; each adversarial test changes its own copy.
  const text = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
  const source = prepareIrProgramSources({
    ...sourceInput({ "./entry.ts": text }),
    policy: nativePolicy,
    promiseDelayProjection: "standalone-native",
    asyncFamilyProjection: "standalone-native",
  });
  if (source.kind !== "prepared") throw new Error(source.detail);
  const support = prepareNumberFormatRuntimeSupport(source, nativePolicy);
  if (support?.batches.length !== 1) throw new Error("genuine formatter fixture did not produce one support batch");
  const input = captureTypedIrProgramInput(source, support);
  program = requireProgram(
    prepareTypedIrProgram(input, { ...typedOptions, policy: nativePolicy, runtimePolicies: [nativePolicy] }),
  );
}, 35000);

describe("Phase C1 live draft ABI lookup", () => {
  it("observes additions, reorder and removal in all three methods with real plan identity", () => {
    const batch = program.runtimeSupport!.batches[0]!;
    const first = program.abi.entries.find((entry) => entry.plan.id === batch.scratch.type.ref.binding.bindingId)!;
    const kernelBinding = batch.kernels[0].ref.binding;
    if (kernelBinding.kind !== "support") throw new Error("genuine fixture lacks support binding");
    const second = program.abi.entries.find((entry) => entry.plan.id === kernelBinding.bindingId)!;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first!.plan.structuralReferenceKey).toBeTypeOf("string");
    const live: PreparedIrAbiEntry[] = [];
    const lookup = preparedIrDraftAbiLookup(live);
    expect(lookup.entries!()).toEqual([]);
    expect(lookup.get(first!.plan.id)).toBeUndefined();
    expect(lookup.bindingIdsForStructuralReference!(first!.plan.structuralReferenceKey!)).toEqual([]);
    live.push(first!, second!);
    expect(lookup.get(first!.plan.id)).toBe(first!.plan);
    expect(lookup.entries!()[1]).toBe(second!.plan);
    live.splice(0, live.length, second!, first!, first!);
    expect(lookup.entries!()).toEqual([second!.plan, first!.plan, first!.plan]);
    expect(lookup.entries!()[0]).toBe(second!.plan);
    expect(lookup.bindingIdsForStructuralReference!(first!.plan.structuralReferenceKey!)).toEqual([
      first!.plan.id,
      first!.plan.id,
    ]);
    live.splice(1);
    expect(lookup.get(first!.plan.id)).toBeUndefined();
    expect(lookup.bindingIdsForStructuralReference!(first!.plan.structuralReferenceKey!)).toEqual([]);
    expect(lookup.entries!()).toEqual([second!.plan]);
    expect(Object.isFrozen(live)).toBe(false);
  });

  it("retains first-match behavior when the live vector contains duplicate IDs", () => {
    const first = program.abi.entries[0]!;
    const replacement = { ...first, plan: { ...first.plan, displayName: "later live plan" } };
    const live = [first, replacement];
    const lookup = preparedIrDraftAbiLookup(live);
    expect(lookup.get(first.plan.id)).toBe(first.plan);
    live.reverse();
    expect(lookup.get(first.plan.id)).toBe(replacement.plan);
    expect(
      lookup.get(createIrBindingId({ domain: "support", ownerId: program.inventory.sources[0]!.id, role: "absent" })),
    ).toBeUndefined();
  });
});

function expectSupportFailure(input: Parameters<typeof assertPreparedIrRuntimeSupportDependencies>[0], detail: string) {
  let caught: unknown;
  try {
    assertPreparedIrRuntimeSupportDependencies(input);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PreparedIrProgramInvariantError);
  expect(caught).toMatchObject({
    code: "invalid-prepared-data",
    message: `runtime support dependencies: ${detail}`,
  });
}

function changedSupport(change: (support: IrRuntimeSupport) => void) {
  const support = structuredClone(program.runtimeSupport!);
  change(support);
  return { ...program, runtimeSupport: support };
}

describe("Phase C1 actual runtime support dependencies", () => {
  it("accepts the genuine prepared support graph and preserves no-support absence", () => {
    expect(program.runtimeSupport!.batches[0]!.calls.length).toBeGreaterThan(0);
    expect(program.runtimeSupport!.batches[0]!.literals.length).toBeGreaterThan(0);
    expect(() => assertPreparedIrRuntimeSupportDependencies(program)).not.toThrow();
    expect(() => oldSupportProof(program)).not.toThrow();
    const { runtimeSupport: omitted, ...without } = program;
    expect(omitted).toBeDefined();
    expect(() => assertPreparedIrRuntimeSupportDependencies(without)).not.toThrow();
  });

  it.each(["type", "callable"] as const)("refuses a missing or duplicated real %s binding", (kind) => {
    const batch = program.runtimeSupport!.batches[0]!;
    const ref = kind === "type" ? batch.scratch.type.ref : batch.kernels[0].ref;
    if (ref.binding.kind !== "support") throw new Error("genuine fixture lacks support binding");
    const id = ref.binding.bindingId;
    const entry = program.abi.entries.find((item) => item.plan.id === id)!;
    expect(entry).toBeDefined();
    expectSupportFailure(
      { ...program, abi: { entries: program.abi.entries.filter((item) => item.plan.id !== id) } },
      "missing or duplicate symbolic dependency",
    );
    expectSupportFailure(
      { ...program, abi: { entries: [...program.abi.entries, entry] } },
      "missing or duplicate symbolic dependency",
    );
  });

  it.each(["key", "slot-policy", "slot-space", "contract"] as const)(
    "refuses a contradictory ABI %s for the actual scratch reference",
    (mutation) => {
      const binding = program.runtimeSupport!.batches[0]!.scratch.type.ref.binding;
      const entry = program.abi.entries.find((item) => item.plan.id === binding.bindingId)!;
      const changed = structuredClone(entry);
      if (mutation === "key") Reflect.set(changed.plan, "structuralReferenceKey", "foreign");
      if (mutation === "slot-policy") Reflect.set(changed.plan, "slotPolicy", "none");
      if (mutation === "slot-space") Reflect.set(changed.plan, "slotSpace", "function");
      if (mutation === "contract") Reflect.set(changed.contract, "kind", "support");
      expectSupportFailure(
        { ...program, abi: { entries: program.abi.entries.map((item) => (item === entry ? changed : item)) } },
        "symbolic dependency lacks its required ABI declaration",
      );
    },
  );

  it("checks the unique entry anchor before traversing malformed support", () => {
    const changed = changedSupport((support) => Reflect.set(support.batches[0]!.scratch.type, "typeIdx", 0));
    expectSupportFailure({ ...changed, inventory: { ...program.inventory, sources: [] } }, "foreign source anchor");
    const anchor = program.inventory.sources.find((source) => source.kind === "entry")!;
    expectSupportFailure(
      { ...program, inventory: { ...program.inventory, sources: [...program.inventory.sources, anchor] } },
      "foreign source anchor",
    );
  });

  it("rejects a foreign scratch type and a hidden foreign type dependency", () => {
    const batch = program.runtimeSupport!.batches[0]!;
    const foreign = irSupportTypeRef(batch.sourceId, "foreign", "foreign");
    expectSupportFailure(
      changedSupport((support) => Reflect.set(support.batches[0]!.scratch.type, "ref", foreign)),
      "foreign or incompatible symbolic scratch type",
    );
    expectSupportFailure(
      changedSupport((support) =>
        Reflect.set(support.batches[0]!.implementation.body, "resultTypes", [{ kind: "string", carrierRef: foreign }]),
      ),
      "foreign symbolic dependency",
    );
  });

  it.each(["storage", "materializer"] as const)("rejects an own literal %s field even when undefined", (field) => {
    expectSupportFailure(
      changedSupport((support) => {
        const batch = support.batches[0]!;
        const path = batch.literals[0]!.path;
        let literal: unknown = batch.implementation.body;
        for (const part of path) literal = (literal as Record<string | number, unknown>)[part];
        expect(literal).toMatchObject({ kind: "string.const" });
        Reflect.set(literal as object, field, undefined);
      }),
      "D1 support literals cannot carry physical storage or materializer attachments",
    );
  });

  it("rejects physical type indices anywhere in the real body", () => {
    expectSupportFailure(
      changedSupport((support) =>
        Reflect.set(support.batches[0]!.implementation.body, "resultTypes", [{ kind: "string", typeIdx: 0 }]),
      ),
      "physical type index in semantic support",
    );
  });

  it("rejects a forbidden dependency-bearing body form", () => {
    expectSupportFailure(
      changedSupport((support) =>
        Reflect.set(support.batches[0]!.implementation.body, "resultTypes", [{ kind: "global" }]),
      ),
      "unsupported dependency-bearing form global",
    );
  });

  it("rejects cycles and sparse buffers while traversing actual body fields", () => {
    expectSupportFailure(
      changedSupport((support) => {
        const body = support.batches[0]!.implementation.body;
        Reflect.set(body, "c1Cycle", body);
      }),
      "cyclic support dependency graph",
    );
    expectSupportFailure(
      changedSupport((support) => {
        const body = support.batches[0]!.implementation.body;
        const sparse: IrInstr[] = new Array(1);
        Reflect.set(body.blocks[0]!, "instrs", sparse);
      }),
      "sparse support dependency graph",
    );
  });
});

const identities = createTestIrFunctionIdentityFactory("issue-3518-runtime-program-c1");
const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const EXTERN = irVal({ kind: "externref" });

function generatorFunction(type: IrType = F64, instrs?: readonly IrInstr[]): PreparedIrFunction {
  const value = asValueId(0);
  return {
    ...identities.next("generator"),
    params: [
      { name: "value", type, value },
      { name: "flag", type: I32, value: asValueId(1) },
    ],
    resultTypes: [],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: instrs ?? [
          {
            kind: "if.stmt",
            cond: asValueId(1),
            then: [
              { kind: "gen.push", value, result: null, resultType: null },
              { kind: "gen.yieldStar", inner: value, result: null, resultType: null },
              { kind: "gen.setReturn", value, result: null, resultType: null },
            ],
            else: [],
            result: null,
            resultType: null,
          },
          { kind: "gen.epilogue", result: asValueId(2), resultType: EXTERN },
        ],
        terminator: { kind: "return", values: [] },
      },
    ],
    exported: false,
    valueCount: 3,
    funcKind: "generator",
  };
}

describe("Phase C1 generator attachments", () => {
  it.each([
    [F64, "__gen_push_f64", true],
    [I32, "__gen_push_i32", true],
    [EXTERN, "__gen_push_ref", false],
    [undefined, "__gen_push_ref", false],
  ] as const)("retains typed push and return classification for %s", (type, symbol, boxing) => {
    expect(generator.irGeneratorPushProviderSymbol(type)).toBe(symbol);
    expect(generator.irGeneratorSetReturnNeedsBoxing(type)).toBe(boxing);
  });

  it("attaches the selected box object, preserves provider order and is idempotent", () => {
    const box = irRuntimeFuncRef("__box_number", "selected-box");
    const original = generatorFunction();
    const visited: (IrType | undefined)[] = [];
    generator.forEachIrGeneratorSetReturn(original, (type) => visited.push(type));
    expect(visited).toEqual([F64]);
    expect(generator.irGeneratorNumberBoxDemand([original])).toBe(true);
    const attached = generator.attachIrGeneratorSupport(original, box);
    expect(attached).not.toBe(original);
    expect(generator.collectAttachedGeneratorProviders([original])).toEqual([]);
    const providers = generator.collectAttachedGeneratorProviders([attached]);
    expect(providers.map((ref) => ref.name)).toEqual([
      "__gen_push_f64",
      "__gen_yield_star",
      "__gen_set_return",
      "selected-box",
      "__create_generator",
    ]);
    expect(providers[3]).toBe(box);
    expect(generator.attachIrGeneratorSupport(attached, box)).toBe(attached);
    expect(oldGenerator.attachIrGeneratorSupport(attached, box)).toBe(attached);
  });

  it("does not attach boxing to an externref return or demand it for ordinary functions", () => {
    const attached = generator.attachIrGeneratorSupport(generatorFunction(EXTERN), undefined);
    expect(generator.collectAttachedGeneratorProviders([attached]).map((ref) => ref.name)).toEqual([
      "__gen_push_ref",
      "__gen_yield_star",
      "__gen_set_return",
      "__create_generator",
    ]);
    const regular = { ...generatorFunction(), funcKind: "regular" as const };
    expect(generator.irGeneratorNumberBoxDemand([regular])).toBe(false);
    expect(generator.attachIrGeneratorSupport(regular, undefined)).toBe(regular);
    expect(generator.collectAttachedGeneratorProviders([regular])).toEqual([]);
  });

  it("preserves unchanged generator buffers and the prepared runtime field", () => {
    const original: PreparedIrFunction = { ...generatorFunction(F64, []), asyncRuntime: undefined };
    const attached = generator.attachIrGeneratorSupport(original, undefined);
    expect(attached).toBe(original);
    expect(attached.blocks).toBe(original.blocks);
    expect(attached.blocks[0]!.instrs).toBe(original.blocks[0]!.instrs);
    expect(Object.hasOwn(attached, "asyncRuntime")).toBe(true);
  });

  it("requires the manifest-selected boxing provider for a numeric return", () => {
    expect(() => generator.attachIrGeneratorSupport(generatorFunction(), undefined)).toThrow(
      "IR gen.setReturn needs numeric boxing but no manifest-selected provider was supplied",
    );
  });

  it.each(["gen.push", "gen.epilogue", "gen.yieldStar", "gen.setReturn"] as const)(
    "rejects a conflicting %s provider even if its display name agrees",
    (kind) => {
      const provider = irRuntimeFuncRef("__foreign_generator", "diagnostic-name");
      const instr: IrInstr =
        kind === "gen.epilogue"
          ? { kind, result: asValueId(2), resultType: EXTERN, provider }
          : kind === "gen.yieldStar"
            ? { kind, inner: asValueId(0), result: null, resultType: null, provider }
            : { kind, value: asValueId(0), result: null, resultType: null, provider };
      expect(() =>
        generator.attachIrGeneratorSupport(generatorFunction(F64, [instr]), irRuntimeFuncRef("__box_number")),
      ).toThrow(`IR ${kind} already carries a different prepared provider binding`);
    },
  );

  it("preserves matching provider object identity despite a different display name", () => {
    const provider = irRuntimeFuncRef("__gen_push_f64", "diagnostic-name");
    const instr: IrInstr = { kind: "gen.push", value: asValueId(0), result: null, resultType: null, provider };
    const original = generatorFunction(F64, [instr]);
    expect(generator.attachIrGeneratorSupport(original, undefined)).toBe(original);
    expect(generator.collectAttachedGeneratorProviders([original])[0]).toBe(provider);
  });

  it("rejects a changed boxing binding and a contradictory boxing presence", () => {
    const attached = generator.attachIrGeneratorSupport(generatorFunction(), irRuntimeFuncRef("__box_number"));
    expect(() => generator.attachIrGeneratorSupport(attached, irRuntimeFuncRef("__foreign_box"))).toThrow(
      "IR gen.setReturn already carries a different prepared provider binding",
    );
    const extern = generator.attachIrGeneratorSupport(generatorFunction(EXTERN), undefined);
    const changed = structuredClone(extern);
    const nested = changed.blocks[0]!.instrs[0]!;
    if (nested.kind !== "if.stmt") throw new Error("generator fixture lost its nested return");
    const returnInstr = nested.then.find((instr) => instr.kind === "gen.setReturn")!;
    Reflect.set(returnInstr, "boxProvider", irRuntimeFuncRef("__box_number"));
    expect(() => generator.attachIrGeneratorSupport(changed, undefined)).toThrow(
      "IR gen.setReturn already carries a different prepared boxing attachment",
    );
  });
});
