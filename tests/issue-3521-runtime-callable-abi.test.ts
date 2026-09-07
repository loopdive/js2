// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irCallableBindingKey, irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { createDerivedIrUnitId } from "../src/ir/identity-values.js";
import { asAsyncStateId, canonicalPromiseAbi, createIrAsyncPlan, verifyIrAsyncPlan } from "../src/ir/async-plan.js";
import { forEachInstrDeep, irVal, type IrFunction, type IrFuncRef } from "../src/ir/nodes.js";
import { prepareIrProgramAbiEntries, preparedIrCallableSignature } from "../src/ir/program-abi-contracts.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareIrProgramSources, type IrProgramSourcePreparation } from "../src/ir/program-source.js";
import { prepareIrProgramRuntimeCallables, preparedIrRuntimeCallableBindingId } from "../src/ir/program-runtime-abi.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import {
  preparedIrProgramAbiLookup,
  preparedIrProgramOwner,
  type PreparedIrAbiEntry,
  type PreparedIrProgram,
} from "../src/ir/program.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime-callable-declarations.js";
import type { RuntimeManifestPolicy } from "../src/ir/runtime-manifest.js";
import { subscribePreparedIrProgram, type PreparedIrProgramObservation } from "../src/ir/program-observation.js";

// Preserve the approved dependency-order control, including its imported-global initializer.
const FILES = {
  "./state.ts": "export let base: number = 9; base = base + 1;",
  "./math.ts":
    'import { base } from "./state";\n\nexport let bias: number = 4;\nbias = base + bias;\n\nexport function combine(seed: number): number {\n  return Math.sqrt(seed + base) + bias;\n}',
  "./entry.ts":
    'import { base } from "./state";\nimport { bias, combine } from "./math";\n\nlet phase: number = 0;\n\nexport function initial(): number {\n  return base + bias;\n}\n\nexport function readPhase(): number {\n  return phase;\n}\n\nexport function run(seed: number): number {\n  phase = 1;\n  return combine(seed) + base;\n}\n',
};
const HOST: RuntimeManifestPolicy = { backend: "wasmgc", target: "host" };
const EXTERN = irVal({ kind: "externref" });
const REF = irRuntimeFuncRef("__new_ReferenceError");
const DECLARATION = irRuntimeCallableDeclaration(REF)!;

function input(files: Record<string, string> = FILES, policy = HOST) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  expect(ast.diagnostics).toEqual([]);
  return {
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    deferTopLevelInit: false,
  };
}

function source(files: Record<string, string>): IrProgramSourcePreparation {
  const result = prepareIrProgramSources(input(files));
  if (result.kind !== "prepared") throw new Error(result.detail);
  return result;
}

function runtimeEntries(entries: readonly PreparedIrAbiEntry[]) {
  return entries.filter((entry) => entry.contract.kind === "callable" && entry.contract.ref.binding.kind === "runtime");
}

function calls(fn: IrFunction): IrFuncRef[] {
  const refs: IrFuncRef[] = [];
  for (const buffer of [
    ...fn.blocks.map((block) => block.instrs),
    ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
  ])
    for (const root of buffer)
      forEachInstrDeep(root, (item) => {
        if (item.kind === "call" && item.target.binding.kind === "runtime") refs.push(item.target);
      });
  return refs;
}

function initializer(
  program: Pick<PreparedIrProgram, "inventory" | "ir" | "derivedUnits">,
  sourceFile: string,
): IrFunction {
  const fn = program.ir.functions.find((item) => {
    const unit = program.inventory.terminalUnits.find((record) => record.id === item.unitId);
    return unit?.kind === "module-init" && preparedIrProgramOwner(program, item.unitId)?.sourceFile === sourceFile;
  });
  if (!fn) throw new Error(`missing original initializer for ${sourceFile}`);
  return fn;
}

function caller(original: IrFunction, ref = REF, count = 1): IrFunction {
  const builder = new IrFunctionBuilder({ unitId: original.unitId, name: original.name }, [], false);
  builder.openBlock();
  const value = builder.emitConst({ kind: "null", ty: EXTERN }, EXTERN);
  for (let index = 0; index < count; index++) builder.emitCall(ref, [value], EXTERN);
  builder.terminate({ kind: "return", values: [] });
  return builder.finish();
}

function replaceBody<T extends { readonly ir: { readonly functions: readonly IrFunction[] } }>(
  value: T,
  fn: IrFunction,
): T {
  return {
    ...value,
    ir: { ...value.ir, functions: value.ir.functions.map((item) => (item.unitId === fn.unitId ? fn : item)) },
  };
}

let prepared: PreparedIrProgram;
let original: IrProgramSourcePreparation;
let observations: PreparedIrProgramObservation[];
let plain: IrProgramSourcePreparation;

beforeAll(() => {
  original = source(FILES);
  plain = source({
    "./body.ts": "export function answer(): number { return 3; }",
    "./entry.ts": 'export { answer } from "./body";',
  });
  observations = [];
  const unsubscribe = subscribePreparedIrProgram((event) => observations.push(event));
  try {
    const result = prepareWholeIrProgram(input());
    if (result.kind !== "prepared") throw new Error(result.detail);
    prepared = result.program;
  } finally {
    unsubscribe();
  }
});

describe("canonical runtime callables in the complete program ABI", () => {
  it("prepares the unchanged three-source/seven-terminal app once with its imported-global TDZ guard", () => {
    expect(createHash("sha256").update(JSON.stringify(FILES)).digest("hex")).toBe(
      "594eaf3f977ec2717777cdde3ff9813753f4c44faa6e3bf50fc6ced726e61b49",
    );
    expect(prepared.inventory.sources).toHaveLength(3);
    expect(prepared.inventory.terminalUnits).toHaveLength(7);
    expect(prepared.ir.functions).toHaveLength(7);
    expect(prepared.derivedUnits).toHaveLength(0);
    expect(observations.map((event) => event.phase)).toEqual(["prepared"]);
    expect(observations[0]!.program).toBe(prepared);
    const mathInitializer = initializer(prepared, "math.ts");
    expect(calls(mathInitializer).map((ref) => irCallableBindingKey(ref.binding))).toContain(
      irCallableBindingKey(REF.binding),
    );
    expect(prepared.startup.map((plan) => plan.sourceId)).toEqual(prepared.inventory.sources.map((item) => item.id));
    expect(prepared.runtime[0]!.prepared.manifest.features).toContain(DECLARATION.feature);
    expect(
      prepared.runtime[0]!.prepared.manifest.providers.some(
        (provider) => provider.id === "host.error.reference.construct",
      ),
    ).toBe(true);
    expect(() => assertPreparedIrProgram(prepared)).not.toThrow();
    expect(preparedIrProgramAbiLookup(prepared).entries()).toHaveLength(prepared.abi.entries.length);
  });

  it("deduplicates repeated calls while keeping the shared ABI anchor separate from the requesting owner", () => {
    const owner = initializer(original, "math.ts");
    const repeated = replaceBody(original, caller(owner, REF, 3));
    expect(calls(repeated.ir.functions.find((fn) => fn.unitId === owner.unitId)!)).toHaveLength(3);
    const collected = prepareIrProgramRuntimeCallables(repeated);
    if (collected.kind !== "prepared") throw new Error(collected.detail);
    expect(collected.declarations).toEqual([DECLARATION]);
    const entries = runtimeEntries(prepareIrProgramAbiEntries(repeated, collected.declarations));
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    const anchor = original.inventory.sources.find((item) => item.kind === "entry")!;
    expect(entry.plan.id).toBe(preparedIrRuntimeCallableBindingId(original.inventory, REF));
    expect(entry.plan.intent).toMatchObject({ origin: "runtime" });
    expect(entry.plan.order.sourceOrder).toBe(anchor.order);
    expect(entry.plan.intent).not.toHaveProperty("unitId");
    expect(entry.plan.intent).not.toHaveProperty("sourceId");
    expect(preparedIrProgramOwner(original, owner.unitId)!.location.sourceId).not.toBe(anchor.id);
    expect(entry.contract).toEqual({ kind: "callable", ref: REF, params: [EXTERN], results: [EXTERN] });
  });

  it("keeps an explicit empty declaration population when no runtime callable is used", () => {
    expect(plain.inventory.terminalUnits).toHaveLength(1);
    const collected = prepareIrProgramRuntimeCallables(plain);
    expect(collected).toEqual({ kind: "prepared", declarations: [] });
    if (collected.kind !== "prepared") throw new Error(collected.detail);
    expect(runtimeEntries(prepareIrProgramAbiEntries(plain, collected.declarations))).toEqual([]);
    expect(() => prepareIrProgramRuntimeCallables({ ...plain, ir: { functions: [] } })).toThrow("missing body");
  });

  it("locates unknown runtime references at their actual source and rejects missing ownership", () => {
    const owner = initializer(original, "math.ts");
    const unknown = caller(owner, irRuntimeFuncRef("__new_ReferenceError_unknown"));
    const result = prepareIrProgramRuntimeCallables(replaceBody(original, unknown));
    expect(result).toMatchObject({
      kind: "invariant",
      code: "unknown-function-ref",
      stage: "resolve",
      ...preparedIrProgramOwner(original, owner.unitId),
    });
    expect(result.kind).not.toBe("prepared");
    expect(() => prepareIrProgramRuntimeCallables({ ...plain, ir: { functions: [unknown] } })).toThrow(
      "no original owner",
    );
    const actualOwner = preparedIrProgramOwner(original, owner.unitId)!;
    const other = original.inventory.terminalUnits.find(
      (unit) => unit.sourceId === actualOwner.location.sourceId && unit.id !== owner.unitId,
    )!;
    expect(other).toBeDefined();
    const forged = {
      ...replaceBody(original, unknown),
      inventory: {
        ...original.inventory,
        allUnits: original.inventory.allUnits.map((unit) =>
          unit.id === owner.unitId ? { ...unit, terminalOwnerId: other.id } : unit,
        ),
      },
    };
    expect(() => prepareIrProgramRuntimeCallables(forged)).toThrow("contradicts the original inventory");
  });

  it("collects a valid semantic async state's runtime demand and preserves a derived failure's original owner", () => {
    const fn = plain.ir.functions[0]!;
    const body = caller(fn);
    const stateBody = body.blocks[0]!.instrs.map((instruction) => {
      if (instruction.kind !== "call") return instruction;
      expect(instruction.alloc).toBeUndefined();
      // Ordinary IR permits this absent allocation field; a semantic async
      // plan represents optional data by omission, never by undefined values.
      const { alloc: _alloc, ...stateInstruction } = instruction;
      return stateInstruction;
    });
    const plan = createIrAsyncPlan({
      schemaVersion: 1,
      kind: "async-function",
      ownerUnitId: fn.unitId,
      abi: canonicalPromiseAbi(null),
      entry: asAsyncStateId(0),
      params: [],
      values: stateBody.map((instruction) => ({ value: instruction.result!, type: instruction.resultType! })),
      spills: [],
      states: [{ id: asAsyncStateId(0), body: stateBody, terminator: { kind: "resolve" } }],
      handlers: [],
      runtimeIntents: ["promise.capability.create", "value.undefined", "promise.settle.fulfill", "promise.resolve"],
    });
    expect(verifyIrAsyncPlan(plan)).toEqual([]);
    const withState = replaceBody(plain, {
      ...fn,
      funcKind: "async",
      resultTypes: [EXTERN],
      valueCount: body.valueCount,
      blocks: fn.blocks.map((block) => ({ ...block, instrs: [], terminator: { kind: "unreachable" as const } })),
      asyncPlan: plan,
    });
    expect(calls(fn)).toEqual([]);
    const collected = prepareIrProgramRuntimeCallables(withState);
    expect(collected).toEqual({ kind: "prepared", declarations: [DECLARATION] });
    if (collected.kind !== "prepared") throw new Error(collected.detail);
    expect(runtimeEntries(prepareIrProgramAbiEntries(withState, collected.declarations))).toHaveLength(1);
    const owner = preparedIrProgramOwner(plain, fn.unitId)!;
    const provenance = {
      parentId: fn.unitId,
      role: "ir-async-state" as const,
      ordinal: 0,
      sourceId: owner.location.sourceId,
      terminalOwnerId: owner.unitId,
    };
    const derived = {
      ...caller(fn, irRuntimeFuncRef("__unknown_state_helper")),
      unitId: createDerivedIrUnitId(provenance),
    };
    const result = prepareIrProgramRuntimeCallables({
      ...plain,
      derivedUnits: [{ ...provenance, id: derived.unitId }],
      ir: { functions: [...plain.ir.functions, derived] },
    });
    expect(result).toMatchObject({ kind: "invariant", code: "unknown-function-ref", ...owner });
  });

  it("rejects duplicate or mutated declaration construction inputs instead of guessing signatures", () => {
    expect(() => prepareIrProgramAbiEntries(original, [DECLARATION, DECLARATION])).toThrow("duplicates declaration");
    for (const mutation of [
      { ...DECLARATION, params: [] },
      { ...DECLARATION, results: [irVal({ kind: "f64" })] },
      { ...DECLARATION, ref: irRuntimeFuncRef("__unknown_runtime_helper") },
      { ...DECLARATION, feature: "math.sqrt" as const },
    ])
      expect(() => prepareIrProgramAbiEntries(original, [mutation])).toThrow("canonical declaration");
  });

  it("rejects missing, duplicate and unused final runtime declarations before reconstructing any lookup", () => {
    const entry = runtimeEntries(prepared.abi.entries)[0]!;
    expect(() =>
      preparedIrProgramAbiLookup({
        ...prepared,
        abi: { entries: prepared.abi.entries.filter((item) => item !== entry) },
      }),
    ).toThrow("runtime ABI declaration population");
    expect(() =>
      preparedIrProgramAbiLookup({ ...prepared, abi: { entries: [...prepared.abi.entries, entry] } }),
    ).toThrow("duplicates a binding");
    const unused = {
      ...prepared,
      ir: {
        ...prepared.ir,
        functions: prepared.ir.functions.map((fn) => (calls(fn).length ? caller(fn, REF, 0) : fn)),
      },
    };
    expect(() => preparedIrProgramAbiLookup(unused)).toThrow("runtime ABI declaration population");
  });

  it.each(["params", "results", "binding", "id", "owner", "order", "unit", "slot"] as const)(
    "rejects a coherently mutated runtime %s contract",
    (field) => {
      const entry = runtimeEntries(prepared.abi.entries)[0]!;
      if (entry.contract.kind !== "callable" || entry.plan.intent.kind !== "callable")
        throw new Error("runtime declaration disappeared");
      const contract = {
        ...entry.contract,
        ...(field === "params" ? { params: [] } : {}),
        ...(field === "results" ? { results: [irVal({ kind: "f64" })] } : {}),
        ...(field === "binding" ? { ref: irRuntimeFuncRef("__unknown_runtime_helper") } : {}),
      };
      const plan = {
        ...entry.plan,
        structuralReferenceKey: irCallableBindingKey(contract.ref.binding),
        ...(field === "id"
          ? { id: preparedIrRuntimeCallableBindingId(prepared.inventory, irRuntimeFuncRef("__foreign_runtime_helper")) }
          : {}),
        ...(field === "order"
          ? { order: { ...entry.plan.order, declarationOrder: entry.plan.order.declarationOrder + 1 } }
          : {}),
        ...(field === "slot" ? { slotSpace: "global" as const } : {}),
        intent: {
          ...entry.plan.intent,
          signature: preparedIrCallableSignature(contract.params, contract.results),
          ...(field === "owner" ? { sourceId: prepared.inventory.sources[0]!.id } : {}),
          ...(field === "unit" ? { unitId: prepared.ir.functions[0]!.unitId } : {}),
        },
      };
      const changed = {
        ...prepared,
        abi: {
          entries: prepared.abi.entries.map((item) =>
            item === entry ? ({ plan, contract } as PreparedIrAbiEntry) : item,
          ),
        },
      };
      expect(() => preparedIrProgramAbiLookup(changed)).toThrow(/runtime ABI/);
    },
  );

  it("requires one exact entry-source anchor for a shared runtime binding", () => {
    const noEntry = {
      ...original,
      inventory: {
        ...original.inventory,
        sources: original.inventory.sources.map((item) => ({ ...item, kind: "source" as const })),
      },
    };
    expect(() => prepareIrProgramAbiEntries(noEntry, [DECLARATION])).toThrow("one exact entry source");
    const twoEntries = {
      ...original,
      inventory: {
        ...original.inventory,
        sources: original.inventory.sources.map((item, index) =>
          index === 0 ? { ...item, kind: "entry" as const } : item,
        ),
      },
    };
    expect(() => prepareIrProgramAbiEntries(twoEntries, [DECLARATION])).toThrow("one exact entry source");
  });

  it("preserves a located unsupported policy result and emits no preparation observation", () => {
    const events: PreparedIrProgramObservation[] = [];
    const unsubscribe = subscribePreparedIrProgram((event) => events.push(event));
    try {
      const result = prepareWholeIrProgram(input(FILES, { ...HOST, target: "strict-no-host" }));
      expect(result).toMatchObject({ kind: "unsupported", sourceFile: "math.ts" });
      expect(result.kind).not.toBe("prepared");
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
