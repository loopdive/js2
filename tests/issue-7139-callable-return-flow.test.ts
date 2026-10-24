// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { prepareSourceClassBindings } from "./helpers/prepared-source-class-bindings.js";
import { requireProgram, typedOptions } from "./helpers/typed-program-fixtures.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import { asValueId, type IrInstr, type IrFunction } from "../src/ir/core/nodes.js";
import { createNativeCallableFlow } from "../src/ir/program/native-callable-flow.js";
import { irUnitFuncRef } from "../src/ir/core/callable-bindings.js";

function requirements(program: ReturnType<typeof prepareSourceClassBindings>["program"]) {
  const source = planNativeSourceClosureRequirements(program, program.runtime[0]!)!;
  return { source, proof: planNativeInvocationRequirements(source, { utf8Storage: false })! };
}

it("authenticates actual escaped callable returns including the canonical provider projection", () => {
  const { source, proof } = requirements(prepareSourceClassBindings(false).program);
  expect(proof.gaps).toEqual([]);
  const uses = proof.uses.filter((use) => use.returnedCallee);
  expect(uses.length).toBeGreaterThanOrEqual(2);
  for (const use of uses) {
    expect(use.returnedCallee!.calls).toHaveLength(1);
    const allocation = source.demands.occurrences[use.returnedCallee!.allocationOccurrence]!.instruction;
    expect(allocation.kind).toBe("closure.new");
    if (allocation.kind !== "closure.new" || allocation.liftedFunc.binding.kind !== "unit")
      throw Error("missing actual returned allocation");
    expect(allocation.liftedFunc.binding.unitId).toBe(use.liftedUnitId);
  }
});

for (const mode of ["null", "mixed", "cycle", "raw"] as const)
  it(`retains a located gap for ${mode} in an accessor's returned callable flow`, () => {
    const fixture = prepareSourceClassBindings(false),
      original = fixture.input.ir.functions.find((fn) => fn.name === "deferred")!;
    const value = asValueId(original.valueCount),
      condition = asValueId(original.valueCount + 1);
    const instructions: IrInstr[] = [];
    let result = original.blocks[0]!.terminator;
    if (result.kind !== "return") throw Error("missing accessor return");
    if (mode === "cycle") {
      instructions.push({
        kind: "call",
        target: irUnitFuncRef(original),
        args: original.params.map((p) => p.value),
        result: value,
        resultType: original.resultTypes[0]!,
      });
      result = { kind: "return", values: [value] };
    } else if (mode === "raw") {
      instructions.push({ kind: "raw.wasm", ops: [{ op: "nop" }], stackDelta: 0, result: null, resultType: null });
    } else {
      instructions.push({
        kind: "const",
        value: { kind: "null", ty: original.resultTypes[0]! },
        result: value,
        resultType: original.resultTypes[0]!,
      });
      if (mode === "null") result = { kind: "return", values: [value] };
      else {
        instructions.push({
          kind: "const",
          value: { kind: "i32", value: 1 },
          result: condition,
          resultType: { kind: "val", val: { kind: "i32" } },
        });
        instructions.push({
          kind: "if.stmt",
          cond: condition,
          then: [{ kind: "early.return", value, result: null, resultType: null }],
          else: [],
          result: null,
          resultType: null,
        });
      }
    }
    const fn = {
      ...original,
      valueCount: original.valueCount + 2,
      blocks: [
        { ...original.blocks[0]!, instrs: [...original.blocks[0]!.instrs, ...instructions], terminator: result },
      ],
    };
    const policy = fixture.program.runtime[0]!.prepared.manifest.policy;
    const program = requireProgram(
      prepareTypedIrProgram(
        { ...fixture.input, ir: { functions: fixture.input.ir.functions.map((row) => (row === original ? fn : row)) } },
        { ...typedOptions, policy, runtimePolicies: [policy] },
      ),
    );
    expect(requirements(program).proof.gaps.some((gap) => gap.detail.includes("allocation/return flow"))).toBe(true);
  });

it("refuses changed invocation receiver arguments despite the same returned closure family", () => {
  const { program } = prepareSourceClassBindings(false),
    original = program.runtime[0]!;
  const projection = {
    ...original,
    prepared: {
      ...original.prepared,
      functions: original.prepared.functions.map((fn) =>
        fn.name !== "run"
          ? fn
          : {
              ...fn,
              blocks: fn.blocks.map((block) => ({
                ...block,
                instrs: block.instrs.map((row) =>
                  row.kind === "call" && row.args.length === 2 ? { ...row, args: [row.args[1]!, row.args[1]!] } : row,
                ),
              })),
            },
      ),
    },
  };
  const altered = { ...program, runtime: [projection] };
  expect(
    requirements(altered).proof.gaps.some((gap) => gap.detail.includes("call/argument/capture transformation mapping")),
  ).toBe(true);
});

for (const swap of [false, true])
  it(`checks two actual same-family factory evaluations without collapsing their result identity, swapped=${swap}`, () => {
    const { program: original } = prepareSourceClassBindings(false),
      selected = original.runtime[0]!;
    const run = original.ir.functions.find((fn) => fn.name === "run")!;
    const call = run.blocks[0]!.instrs.find((row) => row.kind === "call" && row.target.name === "js.closure.call:0")!;
    const first = call.result!,
      second = asValueId(run.valueCount);
    const paired = (fn: IrFunction, exchange: boolean): IrFunction =>
      fn.unitId !== run.unitId
        ? fn
        : {
            ...fn,
            valueCount: fn.valueCount + 1,
            blocks: fn.blocks.map((block) => ({
              ...block,
              instrs: block.instrs.flatMap((row) =>
                row.result !== first
                  ? [row]
                  : [
                      { ...row, result: exchange ? second : first },
                      { ...row, result: exchange ? first : second },
                    ],
              ),
            })),
          };
    const projection = {
      ...selected,
      prepared: { ...selected.prepared, functions: selected.prepared.functions.map((fn) => paired(fn, swap)) },
    };
    const program = {
      ...original,
      ir: { ...original.ir, functions: original.ir.functions.map((fn) => paired(fn, false)) },
      runtime: [projection],
    };
    const source = planNativeSourceClosureRequirements(program, projection)!;
    const actual = createNativeCallableFlow(source).resolve(run.unitId, first);
    if (swap) expect(actual.gap).toMatch(/call\/argument\/capture transformation mapping/);
    else {
      expect(actual.proof?.calls).toHaveLength(1);
      expect(actual.gap).toBeUndefined();
    }
  });
