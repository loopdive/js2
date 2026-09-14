// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import assert from "node:assert/strict";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { ProgramAbiMap } from "../src/ir/program/abi.js";
import { preparedIrCallableSignature } from "../src/ir/program-abi-contracts.js";
import { freezePreparedIrValue } from "../src/ir/program/data.js";
import { asValueId, irVal, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import { irCallableBindingKey } from "../src/ir/callable-bindings.js";
import {
  createIrAsyncPlan,
  createPreparedIrAsyncRuntime,
  sealPreparedIrAsyncRuntimeContainers,
  type IrAsyncPlan,
} from "../src/ir/async-plan.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
import {
  planPreparedHostAsyncFrame,
  type PreparedHostAsyncFrameInput,
  type PreparedHostAsyncFramePlan,
} from "../src/ir/program/prepared-async-frame-plan.js";

// The first source/options are the actual producer control retained for #5716.
const originalSource =
  "export async function run(seed: number): Promise<number> { const first = await (seed + 1); return first; }";
const liveSource =
  "export async function run(seed: number): Promise<number> { const first = await (seed + 1); const second = await (first + 2); return seed + first + second; }";
const voidSource = "export async function run(seed: number): Promise<void> { await seed; }";
const f64 = irVal({ kind: "f64" });
const f32 = irVal({ kind: "f32" });
let original: PreparedIrProgram;
let live: PreparedIrProgram;
let empty: PreparedIrProgram;

function produced(source: string): PreparedIrProgram {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { target: "host", backend: "wasmgc" },
    runtimePolicies: [{ target: "host", backend: "wasmgc" }],
    deferTopLevelInit: false,
  });
  assert.equal(result.kind, "prepared");
  return result.program;
}

function input(program = original): PreparedHostAsyncFrameInput {
  const fn = program.runtime[0]!.prepared.functions.find((candidate) => candidate.name === "run")!;
  assert(fn.asyncRuntime && fn.asyncPlan);
  const anchor = program.inventory.sources.find((source) => source.kind === "entry")!;
  return {
    fn,
    backend: "wasmgc",
    target: "host",
    abiEntries: program.abi.entries,
    anchor,
    declarationOrderStart:
      Math.max(
        ...program.abi.entries
          .filter((row) => row.plan.order.sourceOrder === anchor.order)
          .map((row) => row.plan.order.declarationOrder),
      ) + 1,
    callbacks: { fulfill: 40, reject: 41, occupiedIds: [], occupiedNames: [] },
  };
}

function planned(value = input()): PreparedHostAsyncFramePlan {
  const outcome = planPreparedHostAsyncFrame(value);
  assert.equal(outcome.kind, "planned", outcome.kind === "unsupported" ? outcome.detail : "");
  return outcome.plan;
}

function unsupported(value: PreparedHostAsyncFrameInput, detail: RegExp): void {
  const outcome = planPreparedHostAsyncFrame(value);
  expect(outcome).toMatchObject({
    kind: "unsupported",
    unitId: value.fn.unitId,
    feature: "prepared-host-async-frame",
  });
  assert.equal(outcome.kind, "unsupported");
  expect(outcome.detail).toMatch(detail);
}

function withProjectedBody(value: PreparedHostAsyncFrameInput, body: readonly IrInstr[]): PreparedHostAsyncFrameInput {
  const runtime = value.fn.asyncRuntime!;
  const states = runtime.states.map((state, index) => (index === 0 ? { ...state, body } : state));
  return {
    ...value,
    fn: {
      ...value.fn,
      asyncRuntime: sealPreparedIrAsyncRuntimeContainers({
        ...runtime,
        states,
      }),
    },
  };
}

function withPlan(value: PreparedHostAsyncFrameInput, plan: IrAsyncPlan): PreparedHostAsyncFrameInput {
  const runtime = value.fn.asyncRuntime!;
  assert(runtime.manifest && runtime.providers && runtime.backendRequirements);
  const current = createPreparedIrAsyncRuntime({
    ...runtime,
    plan,
    states: plan.states,
    manifest: runtime.manifest,
    providers: runtime.providers,
    backendRequirements: runtime.backendRequirements,
  });
  return {
    ...value,
    fn: {
      ...value.fn,
      valueCount: plan.values.length,
      asyncPlan: plan,
      asyncRuntime: current,
    },
  };
}

function changeCallSignature(
  value: PreparedHostAsyncFrameInput,
  params: readonly (typeof f64)[],
  results: readonly (typeof f64)[],
): PreparedHostAsyncFrameInput {
  const call = value.fn.asyncRuntime!.states[0]!.body.find((instr) => instr.kind === "call");
  assert(call?.kind === "call");
  const key = irCallableBindingKey(call.target.binding);
  return {
    ...value,
    abiEntries: value.abiEntries.map((row) => {
      if (row.plan.structuralReferenceKey !== key) return row;
      assert(row.plan.intent.kind === "callable" && row.contract.kind === "callable");
      return {
        plan: {
          ...row.plan,
          intent: {
            ...row.plan.intent,
            signature: preparedIrCallableSignature(params, results),
          },
        },
        contract: { ...row.contract, params, results },
      };
    }),
  };
}

/** A real producer's helper is reused with an explicit scalar call signature. */
function floatPlan(spill: boolean): PreparedHostAsyncFrameInput {
  const value = input();
  const plan = value.fn.asyncPlan!;
  const call = plan.states[0]!.body.find((instr) => instr.kind === "call");
  assert(call?.kind === "call");
  const constant: IrInstr = {
    kind: "const",
    result: asValueId(4),
    resultType: f32,
    value: { kind: "f32", value: 2.5 },
  };
  const result: IrInstr = {
    ...call,
    args: [asValueId(3), asValueId(4)],
    result: asValueId(5),
    resultType: f64,
  };
  const first = plan.states[0]!;
  assert(first.terminator.kind === "suspend");
  const next = createIrAsyncPlan({
    ...plan,
    values: [...plan.values, { value: asValueId(4), type: f32 }, { value: asValueId(5), type: f64 }],
    spills: spill ? [{ value: asValueId(4), type: f32, storage: "ssa" }] : [],
    states: [
      {
        ...first,
        body: [...first.body, ...(spill ? [constant] : [])],
        terminator: { ...first.terminator, live: spill ? [asValueId(4)] : [] },
      },
      {
        ...plan.states[1]!,
        body: [...(spill ? [] : [constant]), result],
        terminator: { kind: "resolve", value: asValueId(5) },
      },
    ],
  });
  return withPlan(value, next);
}

beforeAll(() => {
  original = produced(originalSource);
  live = produced(liveSource);
  empty = produced(voidSource);
}, 120000);

describe("accepted host async frame planning", () => {
  it("seals the real numeric producer's primary, nine canonical imports, frame, helpers and exports in one ABI", () => {
    const value = input();
    const plan = planned(value);
    expect(plan.primary.params).toEqual([{ kind: "f64" }]);
    expect(plan.primary.results).toEqual([{ kind: "externref" }]);
    expect(plan.imports).toHaveLength(9);
    expect(plan.entries).toHaveLength(15);
    expect(plan.frame.fields.map((field) => field.type.kind)).toEqual([
      "i32",
      "externref",
      "i32",
      "externref",
      "externref",
      "f64",
      "externref",
    ]);
    expect(plan.resultField).toBe(6);
    expect(plan.calls).toHaveLength(1);
    expect(plan.conversions.map((row) => [row.from.kind, row.to.kind])).toEqual([
      ["f64", "externref"],
      ["externref", "f64"],
    ]);
    for (const imported of plan.imports) {
      const adapter = value.fn.asyncRuntime!.adapters.find((entry) => entry.capability === imported.capability)!;
      expect(imported).toMatchObject({
        module: adapter.record.module,
        field: adapter.record.field,
        params: adapter.record.params.map((kind) => ({ kind })),
        results: adapter.record.results.map((kind) => ({ kind })),
      });
      expect(imported.entry.intent).not.toHaveProperty("sourceId");
      expect(imported.entry.intent).not.toHaveProperty("unitId");
    }
    for (const helper of Object.values(plan.auxiliaries))
      expect(helper.entry.intent).toMatchObject({
        origin: "support",
        unitId: value.fn.unitId,
      });
    const abi = new ProgramAbiMap(original.inventory, original.derivedUnits);
    for (const row of [...original.abi.entries.map((entry) => entry.plan), ...plan.entries]) abi.plan(row);
    abi.sealPlan();
    expect(abi.planningSealed).toBe(true);
    expect(plan.callbacks.map((row) => row.externalName)).toEqual(["__cb_40", "__cb_41"]);
  });

  it("retains live parameters and non-parameter spills from the real two-await producer", () => {
    const value = input(live);
    const plan = planned(value);
    expect(value.fn.asyncPlan!.states.filter((state) => state.terminator.kind === "suspend")).toHaveLength(2);
    expect(plan.values.filter((row) => row.spill !== undefined).length).toBeGreaterThan(0);
    for (const spill of value.fn.asyncPlan!.spills) {
      const mapped = plan.values.find((row) => row.id === spill.value)!;
      const field = mapped.param === undefined ? mapped.spill! : 5 + mapped.param;
      expect(plan.frame.fields[field]!.type).toEqual(scalarType(spill.type));
      expect(plan.frame.fields[field]!.mutable).toBe(mapped.param === undefined);
    }
  });

  it("requires and declares canonical undefined for the real void producer", () => {
    const plan = planned(input(empty));
    const helper = plan.imports.find((row) => row.capability === "async.value.undefined");
    expect(helper).toBeDefined();
    expect(plan.undefinedSource).toEqual({
      kind: "helper",
      bindingId: helper!.bindingId,
    });
  });

  it("produces deterministic frozen data with no retained runtime authority", () => {
    const value = input();
    const plan = planned(value);
    expect(planned(value)).toEqual(plan);
    expect(freezePreparedIrValue(plan)).toEqual(plan);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.frame.fields)).toBe(true);
    expect(plan).not.toHaveProperty("runtime");
    expect(plan).not.toHaveProperty("manifest");
    expect(value.fn.asyncRuntime!.plan).toBe(value.fn.asyncPlan);
  });

  it.each(["standalone", "strict-no-host", "wasi"] as const)(
    "locates the unsupported %s target before emission",
    (target) => {
      unsupported({ ...input(), target }, /do not support/);
    },
  );
  it("locates the unsupported linear backend", () => unsupported({ ...input(), backend: "linear" }, /linear:host/));

  it("keeps detached attachment failures fatal instead of classifying them as a capability gap", () => {
    const value = input();
    const runtime = value.fn.asyncRuntime!;
    const fn: IrFunction = {
      ...value.fn,
      asyncRuntime: { ...runtime, states: [] },
    };
    expect(() => planPreparedHostAsyncFrame({ ...value, fn })).toThrow(/attachment/);
  });
  it("rejects a physical parameter mapping that disagrees with the authenticated plan", () => {
    const value = input();
    const fn = {
      ...value.fn,
      params: [{ ...value.fn.params[0]!, value: asValueId(1) }],
    };
    unsupported({ ...value, fn }, /parameter mapping/);
  });
  it("rejects a missing primary Promise contract", () => {
    const value = input();
    const id = planned(value).primary.bindingId;
    unsupported(
      {
        ...value,
        abiEntries: value.abiEntries.filter((row) => row.plan.id !== id),
      },
      /primary callable ABI/,
    );
  });
  it("rejects missing actual helper bindings", () => {
    const value = input();
    const id = planned(value).calls[0]!.bindingId;
    unsupported(
      {
        ...value,
        abiEntries: value.abiEntries.filter((row) => row.plan.id !== id),
      },
      /accepted call binding/,
    );
  });
  it("checks actual helper arity before materialization", () =>
    unsupported(changeCallSignature(input(), [f64], [f64]), /call signature/));
  it("refuses a helper with multiple physical results", () =>
    unsupported(changeCallSignature(input(), [f64, f64], [f64, f64]), /call signature/));
  it("refuses a used helper whose physical result is missing", () =>
    unsupported(changeCallSignature(input(), [f64, f64], []), /missing call result/));
  it("refuses an unplanned narrowing conversion", () =>
    unsupported(changeCallSignature(input(), [f32, f64], [f64]), /f64 -> f32/));
  it("checks actual projected instructions, rather than only the semantic graph", () => {
    const value = input();
    const helper = original.runtime[0]!.prepared.functions.find((fn) => !fn.asyncPlan)!;
    const operation = helper.blocks
      .flatMap((block) => block.instrs)
      .find((instr) => instr.kind !== "const" && instr.kind !== "call")!;
    expect(operation).toBeDefined();
    unsupported(withProjectedBody(value, [operation]), /unsupported instruction/);
  });
  it("refuses undefined introduced without its selected canonical provider", () => {
    const value = input();
    const body = value.fn.asyncRuntime!.states[0]!.body.map((instr) =>
      instr.kind === "const" ? { ...instr, value: { kind: "undefined" as const } } : instr,
    );
    unsupported(withProjectedBody(value, body), /missing selected async.value.undefined/);
  });
  it("admits transient f32 promotion to a real helper without inventing a frame initializer", () => {
    const plan = planned(floatPlan(false));
    expect(plan.values.find((row) => row.id === 4)).toEqual({
      id: 4,
      type: { kind: "f32" },
    });
    expect(plan.conversions).toContainEqual({
      from: { kind: "f32" },
      to: { kind: "f64" },
      operation: { kind: "numeric", op: "f64.promote_f32" },
    });
  });
  it("refuses a valid live f32 spill before the engine's unsupported default is emitted", () =>
    unsupported(floatPlan(true), /no f32 frame default/));
  it("refuses a semantically valid explicit reject terminator that the adapter cannot emit", () => {
    const value = input();
    const old = value.fn.asyncPlan!;
    const plan = createIrAsyncPlan({
      ...old,
      states: old.states.map((state, index) =>
        index === 1 ? { ...state, terminator: { kind: "reject", reason: asValueId(3) } } : state,
      ),
    });
    unsupported(withPlan(value, plan), /unsupported terminator reject/);
  });
  it("refuses projected successor metadata drift even when the immutable attachment remains authenticated", () => {
    const value = input();
    const runtime = value.fn.asyncRuntime!;
    const states = runtime.states.map((state, index) =>
      index === 1 ? { ...state, terminator: { kind: "complete" as const } } : state,
    );
    const fn = {
      ...value.fn,
      asyncRuntime: sealPreparedIrAsyncRuntimeContainers({
        ...runtime,
        states,
      }),
    };
    unsupported({ ...value, fn }, /state identity\/edge mismatch/);
  });
  it.each(["same", "id", "name", "overflow"] as const)("refuses %s callback collisions or invalid IDs", (mode) => {
    const value = input();
    unsupported(
      {
        ...value,
        callbacks: {
          ...value.callbacks,
          ...(mode === "same"
            ? { reject: 40 }
            : mode === "id"
              ? { occupiedIds: [40] }
              : mode === "name"
                ? { occupiedNames: ["__cb_41"] }
                : { fulfill: 0x80000000 }),
        },
      },
      /callback IDs\/names/,
    );
  });
  it("refuses declaration-order overlap with the original ABI", () =>
    unsupported({ ...input(), declarationOrderStart: 0 }, /identity\/order collision/));
});

function scalarType(type: Parameters<typeof irVal>[0] | ReturnType<typeof irVal>) {
  assert(type.kind === "val");
  return type.val;
}
