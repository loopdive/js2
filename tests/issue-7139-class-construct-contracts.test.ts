// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { classConstructInput, constructPolicy } from "./helpers/prepared-class-construct.js";
import { requireProgram, typedOptions } from "./helpers/typed-program-fixtures.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import { asValueId, type IrInstr } from "../src/ir/core/nodes.js";
import { irIntrinsicFuncRef, irUnitFuncRef } from "../src/ir/core/callable-bindings.js";
import { IR_CONSTRUCT, IR_CLOSURE_RECEIVER } from "../src/ir/core/closure-invocation-callables.js";

function requirements(input: ReturnType<typeof classConstructInput>["input"]) {
  const program = requireProgram(
    prepareTypedIrProgram(input, { ...typedOptions, policy: constructPolicy, runtimePolicies: [constructPolicy] }),
  );
  const source = planNativeSourceClosureRequirements(program, program.runtime[0]!)!;
  return { program, source, requirements: planNativeInvocationRequirements(source, { utf8Storage: false })! };
}

for (const helper of [false, true])
  it(`refuses uncertified raw instructions through actual Construct code, helper=${helper}`, () => {
    const fixture = classConstructInput();
    const target = helper ? fixture.right : fixture.left;
    const raw: IrInstr = { kind: "raw.wasm", ops: [{ op: "nop" }], stackDelta: 0, result: null, resultType: null };
    const patched = {
      ...target,
      blocks: [{ ...target.blocks[0]!, instrs: [raw, ...target.blocks[0]!.instrs] }, ...target.blocks.slice(1)],
    };
    const left = helper
      ? {
          ...fixture.left,
          valueCount: fixture.left.valueCount + 1,
          blocks: [
            {
              ...fixture.left.blocks[0]!,
              instrs: [
                ...fixture.left.blocks[0]!.instrs,
                {
                  kind: "call" as const,
                  target: irUnitFuncRef(fixture.right),
                  args: fixture.left.params.map((param) => param.value),
                  result: asValueId(fixture.left.valueCount),
                  resultType: fixture.left.resultTypes[0]!,
                },
              ],
              terminator: { kind: "return" as const, values: [asValueId(fixture.left.valueCount)] },
            },
            ...fixture.left.blocks.slice(1),
          ],
        }
      : patched;
    const result = requirements({
      ...fixture.input,
      ir: {
        ...fixture.input.ir,
        functions: fixture.input.ir.functions.map((fn) => (fn === fixture.left ? left : fn === target ? patched : fn)),
      },
    });
    expect(result.requirements.gaps.some((gap) => gap.detail.includes("raw.wasm"))).toBe(true);
    expect(acceptPreparedIrProgram(result.program, replayOptions("wasmgc", "standalone"))).toMatchObject({
      kind: "unsupported",
    });
  });

it("refuses an internal entry that reads the ambient receiver", () => {
  const fixture = classConstructInput(),
    original = fixture.left;
  const resultId = asValueId(original.valueCount);
  const read: IrInstr = {
    kind: "call",
    target: irIntrinsicFuncRef(IR_CLOSURE_RECEIVER),
    args: [],
    result: resultId,
    resultType: original.resultTypes[0]!,
  };
  const fn = {
    ...original,
    valueCount: original.valueCount + 1,
    blocks: [
      {
        ...original.blocks[0]!,
        instrs: [...original.blocks[0]!.instrs, read],
        terminator: { kind: "return" as const, values: [resultId] },
      },
      ...original.blocks.slice(1),
    ],
  };
  const result = requirements({
    ...fixture.input,
    ir: { ...fixture.input.ir, functions: fixture.input.ir.functions.map((row) => (row === original ? fn : row)) },
  });
  expect(
    result.requirements.gaps.some(
      (gap) => gap.detail.includes("explicit-only") || gap.detail.includes("receiver entry"),
    ),
  ).toBe(true);
});

it.each([0, 1])("refuses an unknown constructor family at operand %s despite other certified classes", (operand) => {
  const fixture = classConstructInput();
  const fn = {
    ...fixture.outer,
    blocks: fixture.outer.blocks.map((block) => ({
      ...block,
      instrs: block.instrs.map((instruction) =>
        instruction.kind === "try"
          ? {
              ...instruction,
              body: instruction.body.map((row) =>
                row.kind === "call" &&
                row.target.binding.kind === "intrinsic" &&
                row.target.binding.symbol === IR_CONSTRUCT
                  ? { ...row, args: row.args.map((value, index) => (index === operand ? asValueId(1) : value)) }
                  : row,
              ),
            }
          : instruction,
      ),
    })),
  };
  const result = requirements({
    ...fixture.input,
    ir: { ...fixture.input.ir, functions: fixture.input.ir.functions.map((row) => (row === fixture.outer ? fn : row)) },
  });
  expect(result.requirements.gaps.some((gap) => gap.detail.includes("class allocation family proof"))).toBe(true);
});

it("records exact projection-owned class and private code occurrences", () => {
  const fixture = classConstructInput("nested");
  const result = requirements(fixture.input);
  expect(result.requirements.gaps).toEqual([]);
  const uses = result.requirements.uses.filter((use) => use.kind === "construct");
  expect(uses).toHaveLength(4);
  for (const use of uses) {
    expect(use.construct).toBeDefined();
    for (const occurrence of [
      use.construct!.calleeOccurrence,
      use.construct!.newTargetOccurrence,
      use.construct!.closureOccurrence,
    ]) {
      const row = result.source.demands.occurrences[occurrence]!;
      const region = result.source.demands.buffers[row.bufferIndex]!;
      expect(region.view).toBe("projection");
      expect(region.ownerUnitId).toBe(use.ownerUnitId);
    }
  }
});

it("reports the missing linear projection for this WasmGC-only Construct packet", () => {
  const { program } = requirements(classConstructInput().input);
  const outcome = acceptPreparedIrProgram(program, replayOptions("linear", "standalone"));
  expect(outcome).toMatchObject({
    kind: "unsupported",
    code: "body-shape-rejected",
    stage: "build",
    detail: "program has no linear:standalone runtime projection (available: wasmgc:standalone)",
  });
});

it("rejects public arity metadata substituted for the internal Construct protocol", () => {
  const fixture = classConstructInput();
  const left = {
    ...fixture.left,
    closureSubtype: {
      ...fixture.left.closureSubtype!,
      parameters: { kind: "fixed" as const, count: 2, publicLength: 0 },
    },
  };
  const result = requirements({
    ...fixture.input,
    ir: { ...fixture.input.ir, functions: fixture.input.ir.functions.map((fn) => (fn === fixture.left ? left : fn)) },
  });
  expect(result.requirements.gaps.some((gap) => gap.detail.includes("fixed internal protocol parameters"))).toBe(true);
  expect(acceptPreparedIrProgram(result.program, replayOptions("wasmgc", "standalone"))).toMatchObject({
    kind: "unsupported",
  });
});
