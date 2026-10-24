// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import {
  classConstructInput,
  constructPolicy,
  prepareClassConstructProgram,
} from "./helpers/prepared-class-construct.js";
import { requireProgram, typedOptions } from "./helpers/typed-program-fixtures.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { planNativeSourceClosureRequirements } from "../src/ir/program/native-source-closure-requirements.js";
import { planNativeInvocationRequirements } from "../src/ir/program/native-invocation-requirements.js";
import { asValueId, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import { irUnitFuncRef } from "../src/ir/core/callable-bindings.js";
import { createNativeConstructorFlow } from "../src/ir/program/native-constructor-flow.js";

function inspect(input: ReturnType<typeof classConstructInput>["input"]) {
  const program = requireProgram(
    prepareTypedIrProgram(input, {
      ...typedOptions,
      policy: constructPolicy,
      runtimePolicies: [constructPolicy],
    }),
  );
  const source = planNativeSourceClosureRequirements(program, program.runtime[0]!)!;
  return { source, requirements: planNativeInvocationRequirements(source, { utf8Storage: false })! };
}

for (const depth of [1, 2])
  it(`authenticates each actual returned constructor and separate newTarget through ${depth} direct calls`, () => {
    const { source, requirements } = inspect(classConstructInput("marker", depth).input);
    expect(requirements.gaps).toEqual([]);
    const uses = requirements.uses.filter((use) => use.kind === "construct");
    expect(uses).toHaveLength(3);
    for (const use of uses) {
      const proof = use.construct!;
      expect(proof.calleeCalls).toHaveLength(depth);
      expect(proof.newTargetCalls).toHaveLength(depth);
      const region = (occurrence: number) =>
        source.demands.buffers[source.demands.occurrences[occurrence]!.bufferIndex]!;
      expect(region(proof.calleeOccurrence).ownerUnitId).not.toBe(use.ownerUnitId);
      expect(region(proof.closureOccurrence).ownerUnitId).toBe(region(proof.calleeOccurrence).ownerUnitId);
      for (const call of [...proof.calleeCalls, ...proof.newTargetCalls]) {
        expect(region(call).view).toBe("projection");
        expect(source.demands.occurrences[call]!.instruction.kind).toBe("call");
      }
    }
  });

function changedFactory(mode: "cell" | "null" | "mixed" | "same" | "different" | "cycle" | "raw") {
  const fixture = classConstructInput("marker", 1),
    original = fixture.input.ir.functions.find((fn) => fn.name === "factory_left_0")!;
  const nil = original.blocks[0]!.instrs.find((row) => row.kind === "const" && row.value.kind === "null")!;
  const returned = original.blocks[0]!.terminator;
  if (returned.kind !== "return") throw Error("missing real factory return");
  const external = { kind: "val", val: { kind: "externref" } } as const,
    integer = { kind: "val", val: { kind: "i32" } } as const;
  const value = asValueId(original.valueCount),
    condition = asValueId(original.valueCount + 1),
    alternate = asValueId(original.valueCount + 2);
  const body: IrInstr[] = [];
  let result = returned.values[0]!;
  if (mode === "raw")
    body.push({ kind: "raw.wasm", ops: [{ op: "nop" }], stackDelta: 0, result: null, resultType: null });
  else if (mode === "cycle") {
    body.push({
      kind: "call",
      target: irUnitFuncRef(original),
      args: original.params.map((param) => param.value),
      result: value,
      resultType: external,
    });
    result = value;
  } else if (mode === "null") result = nil.result!;
  else {
    body.push({ kind: "refcell.get", cell: original.params[0]!.value, result: value, resultType: external });
    if (mode === "cell") result = value;
    else {
      body.push({ kind: "unary", op: "ref.is_null", rand: value, result: condition, resultType: integer });
      let branch = mode === "same" ? result : nil.result!;
      if (mode === "different") {
        const other = fixture.input.ir.functions.find((fn) => fn.name === "factory_right_0")!;
        body.push({
          kind: "call",
          target: irUnitFuncRef(other),
          args: original.params.map((param) => param.value),
          result: alternate,
          resultType: external,
        });
        branch = alternate;
      }
      body.push({
        kind: "if.stmt",
        cond: condition,
        then: [{ kind: "early.return", value: branch, result: null, resultType: null }],
        else: [],
        result: null,
        resultType: null,
      });
    }
  }
  const fn: IrFunction = {
    ...original,
    valueCount: original.valueCount + 3,
    blocks: [
      {
        ...original.blocks[0]!,
        instrs: [...original.blocks[0]!.instrs.filter((row) => row.kind !== "if.stmt"), ...body],
        terminator: { kind: "return", values: [result] },
      },
    ],
  };
  return {
    ...fixture.input,
    ir: { functions: fixture.input.ir.functions.map((row) => (row === original ? fn : row)) },
  };
}

for (const mode of ["cell", "null", "mixed", "different", "cycle", "raw"] as const)
  it(`keeps an explicit gap for returned constructor flow with ${mode}`, () => {
    const { requirements } = inspect(changedFactory(mode));
    expect(requirements.gaps.some((gap) => gap.detail.includes("class allocation family proof"))).toBe(true);
  });

it("includes embedded early returns when all actual exits have the same allocation family", () => {
  expect(inspect(changedFactory("same")).requirements.gaps).toEqual([]);
});

it("refuses changed factory capture arguments despite the same returned allocation family", () => {
  const { program } = prepareClassConstructProgram("marker", 1);
  const original = program.runtime[0]!;
  const projection = {
    ...original,
    prepared: {
      ...original.prepared,
      functions: original.prepared.functions.map((fn) =>
        fn.name !== "outer"
          ? fn
          : {
              ...fn,
              blocks: fn.blocks.map((block) => ({
                ...block,
                instrs: block.instrs.map((row) =>
                  row.kind === "call" && row.target.name === "factory_left_0"
                    ? { ...row, args: [row.args[1]!, row.args[1]!, row.args[2]!] }
                    : row,
                ),
              })),
            },
      ),
    },
  };
  const altered = { ...program, runtime: [projection] };
  const source = planNativeSourceClosureRequirements(altered, projection)!;
  const requirements = planNativeInvocationRequirements(source, { utf8Storage: false })!;
  expect(requirements.gaps.some((gap) => gap.detail.includes("call/argument/capture transformation mapping"))).toBe(
    true,
  );
});

it("indexes each owner once and reuses completed proofs across repeated normal returns", () => {
  const depth = 14,
    { program } = prepareClassConstructProgram("retained", depth);
  const source = planNativeSourceClosureRequirements(program, program.runtime[0]!)!;
  const row = source.demands.occurrences.find(
    (row) =>
      row.instruction.kind === "call" &&
      row.instruction.target.name === `factory_left_${depth - 1}` &&
      source.demands.buffers[row.bufferIndex]!.view === "projection",
  )!;
  let scans = 0;
  // Read-only instrumentation of this exact census, not a replacement acceptance issuer.
  const occurrences = new Proxy(source.demands.occurrences, {
    get(target, key, receiver) {
      if (key === "entries") scans++;
      return Reflect.get(target, key, receiver);
    },
  });
  const flow = createNativeConstructorFlow({ ...source, demands: { ...source.demands, occurrences } });
  const owner = source.demands.buffers[row.bufferIndex]!.ownerUnitId;
  const proof = flow.resolve(owner, "projection", row.instruction.result!);
  expect(proof?.calls).toHaveLength(depth);
  expect(scans).toBe(depth + 1);
  expect(flow.resolve(owner, "projection", row.instruction.result!)).toBe(proof);
  expect(scans).toBe(depth + 1);
});
