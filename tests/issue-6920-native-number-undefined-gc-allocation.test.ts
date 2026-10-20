// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import * as sourceProducer from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { assertPreparedIrProgram } from "../src/ir/program/validation.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program/allocations.js";
import { assertNativeNumberUndefinedGcAllocations } from "../src/ir/program/native-number-undefined-allocation-validation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { ALLOC_NAMESPACES } from "../src/ir/analysis/alloc-registry.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
function prepare(enabled: boolean, policy: (typeof policies)[number] = policies[0]) {
  const ast = analyzeMultiSource(
    { "./entry.ts": "export function run(x:number):number{const a=[x];return a[99]===a[99]?1:0;}" },
    "./entry.ts",
  );
  const source = sourceProducer.prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: policies,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (source.kind !== "prepared") throw Error(JSON.stringify(source));
  const result = prepareTypedIrProgram(sourceProducer.captureTypedIrProgramInput(source), {
    policy,
    runtimePolicies: policies,
    controls: {
      gvnMode: "off",
      ownership: enabled,
      escape: enabled,
      verifyIntermediateAllocations: true,
      verifyDominanceNaive: true,
    },
  });
  expect(result.kind, JSON.stringify(result)).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return result.program;
}
it.each([false, true])(
  "authentically prepares both GC projections with ordinary namespace controls %s and validates source-free live/codec",
  (enabled) => {
    for (const policy of policies) {
      const program = prepare(enabled, policy);
      expect(program.runtime).toHaveLength(2);
      expect(
        program.allocations.metadata.every(
          (row) =>
            row.entries.some(([key]) => key === ALLOC_NAMESPACES.ownership) &&
            row.entries.some(([key]) => key === ALLOC_NAMESPACES.escape),
        ),
      ).toBe(true);
      const encoded = encodePreparedIrProgram(program);
      const poison = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
        throw Error("source reconstruction forbidden");
      });
      try {
        for (const current of [program, decodePreparedIrProgram(encoded)]) {
          expect(assertNativeNumberUndefinedGcAllocations(current)).toBe(true);
          expect(() => assertPreparedIrProgramAllocations(current)).not.toThrow();
          expect(() => assertPreparedIrProgram(current)).not.toThrow();
        }
        expect(poison).not.toHaveBeenCalled();
      } finally {
        poison.mockRestore();
      }
    }
  },
  120000,
);
it("preserves the legacy three-field generic ownership comparison and diagnostic", () => {
  const program = prepare(false);
  const legacy = { ir: program.ir, allocations: program.allocations, runtimeSupport: program.runtimeSupport };
  expect(assertNativeNumberUndefinedGcAllocations(legacy)).toBe(false);
  expect(() => assertPreparedIrProgramAllocations(legacy)).toThrow(/missing or stale ownership/);
}, 120000);
function mutable(program: PreparedIrProgram): PreparedIrProgram {
  return {
    ...program,
    ir: structuredClone(program.ir),
    allocations: structuredClone(program.allocations),
    runtime: program.runtime.map((view) => ({
      ...view,
      prepared: {
        ...view.prepared,
        functions: structuredClone(view.prepared.functions),
        manifest: { ...view.prepared.manifest, policy: { ...view.prepared.manifest.policy } },
      },
    })),
  };
}
function instructions(program: PreparedIrProgram, selected: boolean): IrInstr[] {
  const result: IrInstr[] = [];
  const functions = selected ? program.runtime[0]!.prepared.functions : program.ir.functions;
  for (const fn of functions)
    for (const block of fn.blocks)
      for (const root of block.instrs) forEachInstrDeep(root, (instr) => result.push(instr));
  return result;
}
it.each([
  "missingOwnership",
  "missingEscape",
  "staleOwnership",
  "unknownNamespace",
  "originalType",
  "selectedType",
  "selectedSSA",
  "selectedBlock",
  "selectedReturn",
  "selectedTag",
  "selectedOrigin",
  "coverageAndInvalid",
])(
  "rejects actual current GC %s evidence before logical approval",
  (kind) => {
    const program = mutable(prepare(false));
    const snapshot = program.allocations;
    if (kind === "missingOwnership" || kind === "missingEscape")
      for (const row of snapshot.metadata)
        Object.assign(row, {
          entries: row.entries.filter(
            ([key]) => key !== (kind === "missingOwnership" ? ALLOC_NAMESPACES.ownership : ALLOC_NAMESPACES.escape),
          ),
        });
    if (kind === "staleOwnership")
      Object.assign(snapshot.metadata[0]!, {
        entries: snapshot.metadata[0]!.entries.map(([key, value]) => [
          key,
          key === ALLOC_NAMESPACES.ownership ? { state: "escaped", ops: [] } : value,
        ]),
      });
    if (kind === "unknownNamespace")
      Object.assign(snapshot.metadata[0]!, { entries: [...snapshot.metadata[0]!.entries, ["foreign", {}]] });
    const instrs = instructions(program, kind !== "originalType");
    const box = instrs.find((instr) => instr.kind === "box")!;
    if (kind === "originalType" || kind === "selectedType")
      Object.assign(box, { resultType: { kind: "val", val: { kind: "i32" } } });
    if (kind === "selectedSSA") Object.assign(box, { value: box.result });
    if (kind === "selectedOrigin") Object.assign(box, { site: { line: 999, column: 1 } });
    const block = program.runtime[0]!.prepared.functions[0]!.blocks[0]!;
    if (kind === "selectedBlock") Object.assign(block, { id: 7 });
    if (kind === "selectedReturn") Object.assign(block.terminator, { values: [] });
    if (kind === "selectedTag") Object.assign(box, { toType: { kind: "dynamic", tag: 2 } });
    if (kind === "coverageAndInvalid") {
      Object.assign(program.runtime[0]!.prepared.functions[0]!, { slots: [{ kind: "val", val: { kind: "f64" } }] });
      const other = program.runtime[1]!.prepared.functions[0]!.blocks[0]!;
      Object.assign(other, { id: 9 });
    }
    expect(() => assertNativeNumberUndefinedGcAllocations(program)).toThrow(
      kind === "coverageAndInvalid" ? /lexical-definition/ : undefined,
    );
    expect(() => assertPreparedIrProgramAllocations(program)).toThrow();
    expect(() => assertPreparedIrProgram(program)).toThrow();
  },
  120000,
);
it("logical allocations do not replace later canonical runtime/provider reproduction", () => {
  const program = mutable(prepare(false));
  Object.assign(program.runtime[0]!.prepared.manifest.policy, { target: "wasi" });
  expect(assertNativeNumberUndefinedGcAllocations(program)).toBe(true);
  expect(() => assertPreparedIrProgram(program)).toThrow(/policy|runtime|projection/);
}, 120000);

it("keeps empty and selected Linear contexts on the unchanged generic fallback", () => {
  const original = prepare(false);
  for (const runtime of [[], original.runtime.map((view) => ({ ...view, backend: "linear" as const }))]) {
    const current = { ...original, runtime };
    expect(assertNativeNumberUndefinedGcAllocations(current)).toBe(false);
    expect(() => assertPreparedIrProgramAllocations(current)).toThrow(/missing or stale ownership/);
  }
}, 120000);
