// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import {
  acceptedPhysicalSetupPlan,
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  emittedProgramBindingIndex,
  emittedStartupAdapterIndex,
  emittedSupportFunctionReceipts,
} from "../src/ir/program-consumer.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";

function emit(deferred = false) {
  const ast = analyzeMultiSource(
    {
      "./entry.ts": `
export var initial: number = 7;
export async function first(seed: number): Promise<number> {
  const value = await (seed + 1);
  return value;
}
export async function second(seed: number): Promise<number> {
  const first = await (seed + 2);
  const second = await (first + 3);
  return second;
}
`,
    },
    "./entry.ts",
  );
  const prepared = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "wasmgc", target: "host" },
    runtimePolicies: [{ backend: "wasmgc", target: "host" }],
    deferTopLevelInit: deferred,
  });
  expect(prepared.kind, JSON.stringify(prepared.kind === "prepared" ? {} : prepared)).toBe("prepared");
  if (prepared.kind !== "prepared") throw new Error(prepared.detail);
  const encoded = encodePreparedIrProgram(prepared.program);
  const decoded = decodePreparedIrProgram(encoded);
  expect(encodePreparedIrProgram(decoded)).toBe(encoded);
  const accepted = acceptPreparedIrProgram(decoded, replayOptions("wasmgc"));
  expect(accepted.kind, JSON.stringify(accepted.kind === "accepted" ? {} : accepted)).toBe("accepted");
  if (accepted.kind !== "accepted") throw new Error(accepted.detail);
  return { accepted, emitted: emitAcceptedIrProgram(accepted) };
}

function requireReceipts(result: ReturnType<typeof emit>) {
  const { accepted, emitted } = result;
  const plan = acceptedPhysicalSetupPlan(accepted);
  const frames = plan.asyncFrames?.frames;
  expect(frames).toHaveLength(2);
  if (!frames) throw new Error("missing real async frame plans");
  const expectedKeys = frames.flatMap((frame) => [
    frame.auxiliaries.resume.bindingId,
    frame.auxiliaries.fulfillStep.bindingId,
    frame.auxiliaries.rejectStep.bindingId,
  ]);
  const receipts = emittedSupportFunctionReceipts(emitted);
  expect(receipts).toHaveLength(6);
  expect(receipts.map((receipt) => receipt.key).sort()).toEqual([...expectedKeys].sort());
  expect(new Set(receipts.map((receipt) => receipt.key)).size).toBe(6);
  expect(new Set(receipts.map((receipt) => receipt.index)).size).toBe(6);
  const importCount = emitted.module.imports.filter((entry) => entry.desc.kind === "func").length;
  for (const frame of frames) {
    for (const role of ["resume", "fulfillStep", "rejectStep"] as const) {
      const auxiliary = frame.auxiliaries[role];
      const receipt = receipts.find((row) => row.key === auxiliary.bindingId);
      expect(receipt).toBeDefined();
      if (!receipt) throw new Error("missing async helper receipt");
      expect(emittedProgramBindingIndex(emitted, auxiliary.bindingId)).toEqual({
        space: "function",
        index: receipt.index,
      });
      const actualBody = emitted.module.functions[receipt.index - importCount];
      expect(actualBody?.name).toBe(auxiliary.entry.displayName);
      expect(actualBody?.body.length).toBeGreaterThan(0);
    }
  }
  const startup = emittedStartupAdapterIndex(emitted);
  expect(startup).toBeTypeOf("number");
  if (startup === undefined) throw new Error("source initializer has no startup adapter");
  expect(emitted.emittedUnitIds).toEqual(plan.functions.map((fn) => fn.unitId));
  const sourceIndices = plan.functions.map((fn) => {
    const binding = emittedProgramBindingIndex(emitted, fn.bindingId);
    expect(binding?.space).toBe("function");
    if (!binding || binding.space !== "function") throw new Error("source body binding missing");
    return binding.index;
  });
  const all = [...sourceIndices, ...receipts.map((receipt) => receipt.index), startup];
  expect(new Set(all).size).toBe(all.length);
  expect([...all].sort((a, b) => a - b)).toEqual(emitted.module.functions.map((_, position) => importCount + position));
  expect(Object.isFrozen(receipts)).toBe(true);
  expect(receipts.every(Object.isFrozen)).toBe(true);
  return receipts;
}

describe("#3527 emitted support receipts authenticate completed physical bodies", () => {
  for (const deferred of [false, true])
    it(`partitions real source, three helpers per async owner, and startup (deferred=${deferred})`, () => {
      const result = emit(deferred);
      const before = requireReceipts(result);
      expect(emitBinary(result.emitted.module).byteLength).toBeGreaterThan(8);
      expect(requireReceipts(result)).toEqual(before);
    });

  it("refuses a structurally forged emission and a cloned module after an authentic positive", () => {
    const result = emit();
    requireReceipts(result);
    expect(() => emittedSupportFunctionReceipts({ ...result.emitted })).toThrow();
    const clone = {
      ...result.emitted,
      module: { ...result.emitted.module, functions: [...result.emitted.module.functions] },
    };
    expect(() => emittedSupportFunctionReceipts(clone)).toThrow();
  });

  it("refuses a modified completed helper body after an authentic positive", () => {
    const result = emit();
    const receipts = requireReceipts(result);
    const imports = result.emitted.module.imports.filter((entry) => entry.desc.kind === "func").length;
    const helper = result.emitted.module.functions[receipts[0]!.index - imports]!;
    expect(helper.body.length).toBeGreaterThan(0);
    helper.body = [];
    expect(() => emittedSupportFunctionReceipts(result.emitted)).toThrow();
  });

  it("refuses reordered physical functions after an authentic positive", () => {
    const result = emit();
    requireReceipts(result);
    const functions = result.emitted.module.functions;
    expect(functions.length).toBeGreaterThan(2);
    [functions[0], functions[1]] = [functions[1]!, functions[0]!];
    expect(() => emittedSupportFunctionReceipts(result.emitted)).toThrow();
  });
});
