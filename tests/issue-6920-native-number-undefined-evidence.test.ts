import { ownTypedIrProgramInput } from "../src/ir/program/input.js";
import { optimizePreparedIrProgramIr } from "../src/ir/program-middleend-ir.js";
import { prepareIrProgramAbiEntries, preparedIrDraftAbiLookup } from "../src/ir/program-abi-contracts.js";
import { createGvnCounters } from "../src/ir/passes/gvn-core.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrInstr, type IrValueId } from "../src/ir/core/nodes.js";
import { expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { analyzeNativeNumberUndefined } from "../src/ir/analysis/allocation-evidence/native-number-undefined-producer.js";
import { verifyNativeNumberUndefinedEvidence } from "../src/ir/runtime/native-number-undefined-profile.js";
import {
  collectNativeNumberUndefinedRequirements,
  assertNativeNumberUndefinedRequirementsCurrent,
} from "../src/ir/program/native-number-undefined-requirements.js";
import { ALLOC_NAMESPACES, copyIrPreparationData } from "../src/ir/analysis/alloc-registry.js";
function specimen(annotate = true) {
  const ast = analyzeMultiSource(
    {
      "./entry.ts": "export function run(x:number):number{const a=[x];return a[99]===a[99]?1:0;}",
    },
    "./entry.ts",
  );
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "linear", target: "standalone" },
    linearVectorProjection: "native-f64",
    deferTopLevelInit: false,
  });
  if (source.kind !== "prepared") throw Error(JSON.stringify(source));
  if (annotate) analyzeNativeNumberUndefined(source.ir, source.allocations, true);
  return source;
}
it("independently reconstructs Number/Undefined partitions and exact ownership/effect namespaces", () => {
  const source = specimen(),
    registry = source.allocations.snapshot();
  expect(verifyNativeNumberUndefinedEvidence(source.ir, registry)).toMatchObject({
    kind: "verified",
    profile: "native-number-undefined-v1",
    namespaces: "ownership-and-escape",
  });
  const requirements = collectNativeNumberUndefinedRequirements(source.ir, registry)!;
  expect(requirements.boxes).toHaveLength(2);
  expect(requirements.occurrences.filter((at) => at.instr.kind === "dyn.eq")).toHaveLength(1);
  expect(() => assertNativeNumberUndefinedRequirementsCurrent(requirements, source.ir, registry)).not.toThrow();
}, 120000);
it("refuses stale and fabricated requirements even when original object identities remain", () => {
  const source = specimen(),
    registry = source.allocations.snapshot();
  const requirements = collectNativeNumberUndefinedRequirements(source.ir, registry)!;
  expect(() => assertNativeNumberUndefinedRequirementsCurrent({ ...requirements }, source.ir, registry)).toThrow(
    /unissued/,
  );
  const copy = copyIrPreparationData(registry);
  Object.assign(copy.metadata[0]!.entries, { extra: "changed" });
  expect(() => assertNativeNumberUndefinedRequirementsCurrent(requirements, source.ir, copy)).toThrow();
}, 120000);
it("rejects forged ownership instead of consuming producer assertions", () => {
  const source = specimen();
  const requirements = collectNativeNumberUndefinedRequirements(source.ir, source.allocations.snapshot())!;
  source.allocations.annotate(requirements.boxes[0]!.allocationId, ALLOC_NAMESPACES.ownership, {
    state: "escaped",
    ops: [],
  });
  expect(verifyNativeNumberUndefinedEvidence(source.ir, source.allocations.snapshot())).toMatchObject({
    kind: "invalid",
    code: "namespace-value",
  });
}, 120000);
it("rejects changed box operands against issued complete body custody", () => {
  const source = specimen();
  const requirements = collectNativeNumberUndefinedRequirements(source.ir, source.allocations.snapshot())!;
  const box = requirements.boxes[0]!.instr;
  Object.assign(box, { value: source.ir.functions[0]!.params[0]!.value });
  expect(() =>
    assertNativeNumberUndefinedRequirementsCurrent(requirements, source.ir, source.allocations.snapshot()),
  ).toThrow(/changed/);
}, 120000);

it("rejects a typed exact-index test substituted for the complete bounds guard", () => {
  const source = specimen(),
    definitions = new Map<IrValueId, IrInstr>();
  for (const fn of source.ir.functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instr) => {
          if (instr.result !== null) definitions.set(instr.result, instr);
        });
  let changed = false;
  for (const instr of definitions.values())
    if (instr.kind === "if") {
      const condition = definitions.get(instr.cond);
      if (condition?.kind === "binary" && condition.op === "i32.and") {
        Object.assign(instr, { cond: condition.rhs });
        changed = true;
        break;
      }
    }
  expect(changed).toBe(true);
  expect(verifyNativeNumberUndefinedEvidence(source.ir, source.allocations.snapshot())).toMatchObject({
    kind: "invalid",
    code: "lexical-definition",
  });
}, 120000);

it.each([false, true])(
  "derives genuine native namespaces with ordinary ownership/escape controls %s",
  (enabled) => {
    const source = specimen(false);
    expect(verifyNativeNumberUndefinedEvidence(source.ir, source.allocations.snapshot())).toMatchObject({
      kind: "verified",
      namespaces: "encoding-only",
    });
    expect(
      source.allocations
        .snapshot()
        .metadata.every((row) =>
          row.entries.every(([key]) => key !== ALLOC_NAMESPACES.ownership && key !== ALLOC_NAMESPACES.escape),
        ),
    ).toBe(true);
    const { input, allocations } = ownTypedIrProgramInput(captureTypedIrProgramInput(source));
    const calls = vi.spyOn(allocations, "annotate");
    try {
      const controls = {
        gvnMode: "off" as const,
        ownership: enabled,
        escape: enabled,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: true,
      };
      const optimized = optimizePreparedIrProgramIr(
        {
          ...input,
          abi: preparedIrDraftAbiLookup(prepareIrProgramAbiEntries(input)),
          policy: { backend: "wasmgc", target: "standalone" },
        },
        allocations,
        controls,
        createGvnCounters(),
      );
      expect(controls.ownership).toBe(enabled);
      expect(controls.escape).toBe(enabled);
      const report = verifyNativeNumberUndefinedEvidence(optimized.ir, allocations.snapshot());
      expect(report).toMatchObject({
        kind: "verified",
        profile: "native-number-undefined-v1",
        namespaces: "ownership-and-escape",
      });
      expect(calls.mock.calls.filter((call) => call[1] === ALLOC_NAMESPACES.ownership).length).toBeGreaterThanOrEqual(
        3,
      );
      expect(calls.mock.calls.filter((call) => call[1] === ALLOC_NAMESPACES.escape).length).toBeGreaterThanOrEqual(3);
      console.log(
        "native namespace derivation",
        JSON.stringify({
          enabled,
          sites: report?.kind === "verified" ? report.census.allocations : null,
          ownershipCalls: calls.mock.calls.filter((call) => call[1] === ALLOC_NAMESPACES.ownership).length,
          escapeCalls: calls.mock.calls.filter((call) => call[1] === ALLOC_NAMESPACES.escape).length,
        }),
      );
    } finally {
      calls.mockRestore();
    }
  },
  120000,
);

it.each(["site", "origin", "result", "scope", "ssa", "unit", "negation"])(
  "rejects hostile fresh-body %s evidence",
  (kind) => {
    const source = specimen(),
      snapshot = source.allocations.snapshot();
    const requirements = collectNativeNumberUndefinedRequirements(source.ir, snapshot)!;
    const box = requirements.boxes[0]!.instr;
    if (kind === "site") Object.assign(box, { alloc: snapshot.size + 10 });
    if (kind === "origin") Object.assign(box, { site: { line: 99, column: 7 } });
    if (kind === "result") Object.assign(box, { resultType: { kind: "val", val: { kind: "i32" } } });
    if (kind === "scope") Object.assign(box, { value: box.result });
    if (kind === "ssa") Object.assign(box, { result: source.ir.functions[0]!.params[0]!.value });
    if (kind === "unit") Object.assign(source.ir, { functions: [...source.ir.functions, source.ir.functions[0]!] });
    if (kind === "negation")
      Object.assign(requirements.occurrences.find((at) => at.instr.kind === "dyn.eq")!.instr, { negate: undefined });
    expect(verifyNativeNumberUndefinedEvidence(source.ir, snapshot)).toMatchObject({ kind: "invalid" });
  },
  120000,
);

it.each([
  "block",
  "returnArity",
  "returnType",
  "literal",
  "binaryResult",
  "binaryOperand",
  "unaryOperand",
  "initializerType",
  "capacity",
  "readIndex",
  "lengthResult",
  "valueCount",
  "valueId",
  "typeRef",
  "declarations",
])(
  "pure closed representability independently rejects malformed %s without runtime verifier",
  async (kind) => {
    const { inspectNativeNumberUndefinedBodies } =
      await import("../src/ir/analysis/allocation-evidence/native-number-undefined-body.js");
    const source = specimen(),
      fn = source.ir.functions[0]!,
      block = fn.blocks[0]!;
    const instrs: IrInstr[] = [];
    for (const root of block.instrs) forEachInstrDeep(root, (instr) => instrs.push(instr));
    const first = <K extends IrInstr["kind"]>(k: K) =>
      instrs.find((instr): instr is Extract<IrInstr, { kind: K }> => instr.kind === k)!;
    const float = instrs.find((instr) => instr.kind === "const" && instr.value.kind === "f64")!;
    const comparison = instrs.find((instr) => instr.kind === "binary" && instr.op === "f64.eq")!;
    if (kind === "block") Object.assign(block, { id: 9 });
    if (kind === "returnArity") Object.assign(block.terminator, { values: [] });
    if (kind === "returnType") Object.assign(fn, { resultTypes: [{ kind: "val", val: { kind: "i32" } }] });
    if (kind === "literal") Object.assign(float, { value: { kind: "f64", value: false } });
    if (kind === "binaryResult") Object.assign(comparison, { resultType: { kind: "val", val: { kind: "f64" } } });
    if (kind === "binaryOperand") Object.assign(comparison, { lhs: first("vec.len").result });
    if (kind === "unaryOperand")
      Object.assign(instrs.find((instr) => instr.kind === "unary" && instr.op === "f64.convert_i32_s")!, {
        rand: float.result,
      });
    if (kind === "initializerType")
      Object.assign(first("vec.new_fixed"), { elementType: { kind: "val", val: { kind: "i32" } } });
    if (kind === "capacity") Object.assign(first("vec.new_fixed"), { capacity: 0.5 });
    if (kind === "readIndex") Object.assign(first("vec.get"), { index: float.result });
    if (kind === "lengthResult") Object.assign(first("vec.len"), { resultType: { kind: "val", val: { kind: "f64" } } });
    if (kind === "valueCount") Object.assign(fn, { valueCount: 0 });
    if (kind === "valueId") Object.assign(float, { result: fn.valueCount + 1 });
    if (kind === "typeRef")
      Object.assign(float, { resultType: { kind: "val", val: { kind: "f64" }, typeRef: { kind: "named" } } });
    if (kind === "declarations")
      Object.assign(source.ir, { declaredGlobals: new Map([["foreign", { kind: "val", val: { kind: "f64" } }]]) });
    expect(() => inspectNativeNumberUndefinedBodies(source.ir, source.allocations.snapshot())).toThrow();
    expect(verifyNativeNumberUndefinedEvidence(source.ir, source.allocations.snapshot())?.kind).not.toBe("verified");
  },
  120000,
);

it("neutral representability accepts a consistent other opaque domain but canonical runtime issuance refuses it", async () => {
  const { inspectNativeNumberUndefinedBodies } =
    await import("../src/ir/analysis/allocation-evidence/native-number-undefined-body.js");
  const source = specimen(),
    requirements = collectNativeNumberUndefinedRequirements(source.ir, source.allocations.snapshot())!;
  const snapshot = copyIrPreparationData(source.allocations.snapshot());
  for (const occurrence of requirements.occurrences) {
    const instr = occurrence.instr;
    if (instr.kind === "box") {
      const type = { kind: "dynamic", tag: 2 };
      Object.assign(instr, { toType: type, resultType: type });
      Object.assign(
        snapshot.entries[instr.alloc!]!.state === "live"
          ? (snapshot.entries[instr.alloc!] as { site: object }).site
          : {},
        { type },
      );
    }
    if (instr.kind === "tag.test" && instr.tagId === 3) Object.assign(instr, { tagId: 2 });
  }
  expect(inspectNativeNumberUndefinedBodies(source.ir, snapshot)).toBeDefined();
  expect(verifyNativeNumberUndefinedEvidence(source.ir, snapshot)?.kind).not.toBe("verified");
  expect(() => collectNativeNumberUndefinedRequirements(source.ir, snapshot)).toThrow();
  expect(() => assertNativeNumberUndefinedRequirementsCurrent(requirements, source.ir, snapshot)).toThrow();
}, 120000);

it("direct neutral and canonical proof reject a foreign namespace without generic allocation prelude", async () => {
  const { inspectNativeNumberUndefinedNamespaces } =
    await import("../src/ir/analysis/allocation-evidence/native-number-undefined-profile.js");
  const source = specimen(),
    snapshot = source.allocations.snapshot();
  Object.assign(snapshot.metadata[0]!, { entries: [...snapshot.metadata[0]!.entries, ["foreign", {}]] });
  expect(inspectNativeNumberUndefinedNamespaces(source.ir, snapshot)).toMatchObject({
    kind: "invalid",
    code: "namespace-presence",
  });
  expect(verifyNativeNumberUndefinedEvidence(source.ir, snapshot)).toMatchObject({
    kind: "invalid",
    code: "namespace-presence",
  });
  expect(() => collectNativeNumberUndefinedRequirements(source.ir, snapshot)).toThrow();
}, 120000);
it("direct proofs reject metadata getters without evaluating them", async () => {
  const { inspectNativeNumberUndefinedNamespaces } =
    await import("../src/ir/analysis/allocation-evidence/native-number-undefined-profile.js");
  const source = specimen(),
    snapshot = source.allocations.snapshot();
  let reads = 0;
  Object.defineProperty(snapshot, "metadata", {
    get() {
      reads++;
      throw Error("metadata getter executed");
    },
    enumerable: true,
  });
  expect(inspectNativeNumberUndefinedNamespaces(source.ir, snapshot)).toMatchObject({ kind: "invalid" });
  expect(verifyNativeNumberUndefinedEvidence(source.ir, snapshot)).toMatchObject({ kind: "invalid" });
  expect(() => collectNativeNumberUndefinedRequirements(source.ir, snapshot)).toThrow();
  expect(reads).toBe(0);
}, 120000);
it("direct proofs reject module population getters before selection without evaluating them", async () => {
  const { inspectNativeNumberUndefinedNamespaces } =
    await import("../src/ir/analysis/allocation-evidence/native-number-undefined-profile.js");
  const { inspectNativeNumberUndefinedBodies } =
    await import("../src/ir/analysis/allocation-evidence/native-number-undefined-body.js");
  const source = specimen(),
    registry = source.allocations.snapshot();
  let reads = 0;
  Object.defineProperty(source.ir, "functions", {
    get() {
      reads++;
      throw Error("module getter executed");
    },
    enumerable: true,
  });
  expect(() => inspectNativeNumberUndefinedBodies(source.ir, registry)).toThrow();
  expect(inspectNativeNumberUndefinedNamespaces(source.ir, registry)).toMatchObject({ kind: "invalid" });
  expect(verifyNativeNumberUndefinedEvidence(source.ir, registry)).toMatchObject({ kind: "invalid" });
  expect(() => collectNativeNumberUndefinedRequirements(source.ir, registry)).toThrow();
  expect(reads).toBe(0);
}, 120000);
