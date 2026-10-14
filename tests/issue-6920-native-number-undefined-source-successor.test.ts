import { createIrNativeNumberUndefinedFinalizationPolicyReader } from "./helpers/ir-native-number-undefined-finalization-policy-successor.js";
import { createIrNativeNumberUndefinedOptimizationPolicyReader as originalOptimizationPolicyReader } from "./helpers/ir-native-number-undefined-optimization-policy-successor.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import ts from "typescript";
import {
  createIrNativeNumberUndefinedSourceReader as capture,
  assertIrNativeNumberUndefinedSourceReceiptStructure as structure,
  irNativeNumberUndefinedSourceReceiptPath as receiptPath,
} from "./helpers/ir-native-number-undefined-source-successor.js";
import type { IrNativeNumberUndefinedSourceReceipt } from "./helpers/ir-native-number-undefined-source-successor.js";
import { createIrNativeClassLayoutSourceReader } from "./helpers/ir-native-class-layout-source-successor.js";
import { readBeforeIrNativeAllocationTypeOwnership } from "./helpers/ir-native-allocation-type-ownership-successor.js";
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

const physicalDisk = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const actualDisk = (path: string): string => createIrNativeNumberUndefinedFinalizationPolicyReader(physicalDisk)(path);
const createIrNativeNumberUndefinedOptimizationPolicyReader = (supplied: (path: string) => string) =>
  originalOptimizationPolicyReader(
    supplied === actualDisk ? createIrNativeNumberUndefinedFinalizationPolicyReader(physicalDisk) : supplied,
  );
const disk = (path: string): string => createIrNativeNumberUndefinedOptimizationPolicyReader(actualDisk)(path);
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const blob = (text: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex");
const text = disk(receiptPath),
  receipt = JSON.parse(text) as IrNativeNumberUndefinedSourceReceipt;
const required = [
  receiptPath,
  ...receipt.sources.map((r) => r.path),
  ...receipt.anchors.map((r) => r.path),
  ...receipt.callers.map((r) => r.path),
];
const snapshot = (): Map<string, string> => {
  const current = createIrNativeNumberUndefinedOptimizationPolicyReader(actualDisk);
  return new Map(required.map((path) => [path, current(path)]));
};
const reader =
  (values: ReadonlyMap<string, string>, reads: string[] = []) =>
  (path: string): string => {
    reads.push(path);
    const value = values.get(path);
    if (value === undefined) throw Error(`missing ${path}`);
    return value;
  };
const allocations = "src/ir/program/allocations.ts";
const helper = "tests/helpers/ir-native-number-undefined-source-successor.ts";
it("R01 independently pins the complete helper and fixed receipt on the frozen actual 2016 source policy", () => {
  expect(Buffer.byteLength(disk(helper))).toBe(6768);
  expect(sha(disk(helper))).toBe("f5ee7cf91cb521c643c1a2c41cfd801b547de0fa1440c85edf551ba388ae4122");
  expect(Buffer.byteLength(text)).toBe(32537);
  expect(sha(text)).toBe("660b59f167026c48f33f8b34e9ef785d54874a4abdb2f3348b761458a228e750");
  structure(receipt);
  expect(receipt.sources).toHaveLength(95);
  expect(receipt.anchors).toHaveLength(10);
  expect(receipt.callers).toHaveLength(3);
  expect(new Set(required).size).toBe(109);
  const policy = disk("scripts/compiler-boundaries.json");
  expect(Buffer.byteLength(policy)).toBe(637204);
  expect(sha(policy)).toBe("f1934c0f22726ed604b009bc764ac3110f251f2aefb2533fa0dca7c13f874d88");
  expect(JSON.parse(policy).files).toHaveLength(2016);
});
it("R02 captures exactly 109 physical operands once and delivers mapped historical values without rereads", () => {
  const reads: string[] = [];
  const captured = capture(reader(snapshot(), reads));
  expect(reads).toEqual(required);
  for (const path of required) expect(typeof captured(path)).toBe("string");
  expect(reads).toEqual(required);
  expect(sha(captured(allocations))).toBe("aec062632da95addb294e203514e8218284177bfccd7154f3cbb1d8bdd412c33");
});
it("R03 independently proves all four complete raw inverses and reciprocal forwards", () => {
  const captured = capture(disk);
  expect(receipt.transforms).toHaveLength(4);
  for (const transform of receipt.transforms) {
    const current = Buffer.from(disk(transform.path)),
      pieces: Buffer[] = [];
    let cursor = 0;
    for (const edit of transform.edits) {
      expect(current.subarray(edit.currentStart, edit.currentEnd).toString()).toBe(edit.currentText);
      pieces.push(current.subarray(cursor, edit.currentStart), Buffer.from(edit.beforeText));
      cursor = edit.currentEnd;
    }
    pieces.push(current.subarray(cursor));
    const before = Buffer.concat(pieces);
    expect(before.toString()).toBe(captured(transform.path));
    expect(before.length).toBe(transform.before.bytes);
    expect(sha(before.toString())).toBe(transform.before.sha256);
    expect(blob(before.toString())).toBe(transform.before.gitBlob);
    const replay: Buffer[] = [];
    cursor = 0;
    for (const edit of transform.edits) {
      expect(before.subarray(edit.beforeStart, edit.beforeEnd).toString()).toBe(edit.beforeText);
      replay.push(before.subarray(cursor, edit.beforeStart), Buffer.from(edit.currentText));
      cursor = edit.beforeEnd;
    }
    replay.push(before.subarray(cursor));
    expect(Buffer.concat(replay).equals(current)).toBe(true);
  }
});
it("R04 verifies actual import, optional runtime context and one added GC branch while preserving all generic statements", () => {
  const current = disk(allocations),
    before = capture(disk)(allocations);
  const parse = (source: string) =>
    ts.createSourceFile(allocations, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const a = parse(before),
    b = parse(current);
  const fn = (file: ts.SourceFile, name: string) =>
    file.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name)!;
  expect(b.statements.filter(ts.isImportDeclaration).map((n) => n.getText(b))).toContain(
    'import { assertNativeNumberUndefinedGcAllocations } from "./native-number-undefined-allocation-validation.js";',
  );
  expect(fn(b, "assertPreparedIrProgramAllocations").parameters[0]!.type!.getText(b)).toContain(
    'Partial<Pick<PreparedIrProgram, "runtime">>',
  );
  for (const name of ["analyzeIrRuntimeSupportAllocations", "assertPreparedIrProgramAllocations"]) {
    const old = fn(a, name).body!.statements.map((n) => n.getText(a)),
      now = fn(b, name).body!.statements.map((n) => n.getText(b));
    const branch = "if (assertNativeNumberUndefinedGcAllocations(program)) return;";
    expect(now.filter((s) => s !== branch)).toEqual(old);
    if (name === "assertPreparedIrProgramAllocations") {
      expect(old).toHaveLength(15);
      expect(now).toHaveLength(16);
      const index = now.indexOf(branch);
      expect(now[index - 1]).toContain("assertPreparedIrFunctionAllocationTypesAndStates");
      expect(now[index + 1]).toContain("const expected = new Map");
    }
  }
});
it("R05 rejects every current source mutation including new evidence dependencies", async () => {
  let tested = 0;
  for (const row of receipt.sources) {
    const values = snapshot();
    values.set(row.path, values.get(row.path)! + "\n");
    expect(() => capture(reader(values))).toThrow(`complete source pin ${row.path}`);
    tested++;
    await yieldTurn();
  }
  expect(tested).toBe(95);
});
it("R06 rejects every omitted source operand before historical delivery", async () => {
  let tested = 0;
  for (const row of receipt.sources) {
    const values = snapshot();
    values.delete(row.path);
    expect(() => capture(reader(values))).toThrow(`missing ${row.path}`);
    tested++;
    await yieldTurn();
  }
  expect(tested).toBe(95);
});
it("R07 authenticates every whole old anchor and actual current caller, with missing and changed controls", async () => {
  let tested = 0;
  for (const row of [...receipt.anchors, ...receipt.callers]) {
    const values = snapshot(),
      old = values.get(row.path)!;
    values.set(row.path, old + "\n");
    expect(() => capture(reader(values))).toThrow(`complete source pin ${row.path}`);
    values.delete(row.path);
    expect(() => capture(reader(values))).toThrow(`missing ${row.path}`);
    tested += 2;
    await yieldTurn();
  }
  expect(tested).toBe(26);
});
it("R08 current caller custody rejects a changed real assertion as well as changed new reader binding", () => {
  for (const row of receipt.callers) {
    for (const marker of ["expect(", "createIrNativeNumberUndefinedSourceReader"]) {
      const values = snapshot(),
        old = values.get(row.path)!,
        at = old.indexOf(marker);
      expect(at).toBeGreaterThanOrEqual(0);
      values.set(row.path, old.slice(0, at) + "!" + old.slice(at + 1));
      expect(() => capture(reader(values))).toThrow(`complete source pin ${row.path}`);
    }
  }
});
it("R09 rejects every fixed receipt byte change, format change and caller-computed replacement", () => {
  const forged = structuredClone(receipt);
  (forged.sources[0] as { sha256: string }).sha256 = sha("forged");
  for (const source of [
    "",
    text.slice(0, -1),
    text + "\n",
    JSON.stringify(receipt),
    JSON.stringify(forged, null, 2) + "\n",
  ]) {
    const values = snapshot();
    values.set(receiptPath, source);
    expect(() => capture(reader(values))).toThrow("complete receipt pin");
  }
});
it("R10 closes receipt DATA population, identities, source order, spans and complete pins against repins", () => {
  const variants = [
    { ...receipt, extra: true },
    { ...receipt, sources: receipt.sources.slice(1) },
    { ...receipt, callers: [...receipt.callers, receipt.callers[0]] },
    { ...receipt, anchors: [...receipt.anchors].reverse() },
    { ...receipt, finalComposition: "foreign" },
    { ...receipt, transforms: receipt.transforms.slice(1) },
    {
      ...receipt,
      sources: receipt.sources.map((r, i) =>
        i === 0 ? { ...r, sha256: sha("forged"), gitBlob: blob("forged"), bytes: 6 } : r,
      ),
    },
    {
      ...receipt,
      transforms: receipt.transforms.map((r, i) =>
        i === 0
          ? { ...r, edits: r.edits.map((e, j) => (j === 0 ? { ...e, currentStart: e.currentStart + 1 } : e)) }
          : r,
      ),
    },
  ];
  for (const value of variants) expect(() => structure(value)).toThrow("fixed receipt DATA population");
});
it("R11 refuses root, nested and array getters without executing them", () => {
  let calls = 0;
  for (const where of ["root", "pin", "array"]) {
    const value = structuredClone(receipt),
      getter = {
        enumerable: true,
        get() {
          calls++;
          throw Error("executed");
        },
      };
    if (where === "root") Object.defineProperty(value, "sources", getter);
    if (where === "pin") Object.defineProperty(value.sources[0], "sha256", getter);
    if (where === "array") Object.defineProperty(value.sources, "0", getter);
    expect(() => structure(value)).toThrow(/DATA descriptor|array descriptor/);
  }
  expect(calls).toBe(0);
});
it("R12 refuses symbols, holes, array extra properties, cycles, exotic prototypes and functions", () => {
  const hole = structuredClone(receipt);
  Reflect.deleteProperty(hole.sources, "0");
  const extra = structuredClone(receipt);
  Object.defineProperty(extra.sources, "extra", { value: 1, enumerable: true });
  const cycle = { ...receipt, extra: {} as unknown };
  cycle.extra = cycle;
  const proto = Object.assign(Object.create({ foreign: true }), receipt);
  const hidden = { ...receipt };
  Object.defineProperty(hidden, "hidden", { value: 1 });
  for (const value of [
    { ...receipt, [Symbol("extra")]: 1 },
    hole,
    extra,
    cycle,
    proto,
    hidden,
    { ...receipt, extra: () => 0 },
  ])
    expect(() => structure(value)).toThrow(/DATA/);
});
it("R13 reauthenticates source after warm capture and restoration without sharing approval", () => {
  const values = snapshot(),
    reads: string[] = [],
    actual = reader(values, reads),
    first = capture(actual),
    old = values.get(allocations)!;
  values.set(allocations, old + "\n");
  expect(first(allocations)).toBe(capture(disk)(allocations));
  expect(() => capture(actual)).toThrow(`complete source pin ${allocations}`);
  values.set(allocations, old);
  reads.length = 0;
  expect(capture(actual)(allocations)).toBe(first(allocations));
  expect(reads).toEqual(required);
});
it("R14 rejects warm anchor, current caller and receipt drift and freshly succeeds after restoration", () => {
  const values = snapshot(),
    actual = reader(values);
  capture(actual);
  for (const path of [receipt.anchors[0]!.path, receipt.callers[0]!.path, receiptPath]) {
    const old = values.get(path)!;
    values.set(path, old + "\n");
    expect(() => capture(actual)).toThrow(/complete source pin|complete receipt pin/);
    values.set(path, old);
    expect(capture(actual)(allocations)).toBe(capture(disk)(allocations));
  }
});
it("R15 permits one unknown physical read only after complete capture and never coerces source objects", () => {
  const values = snapshot(),
    reads: string[] = [];
  values.set("opaque.txt", "opaque");
  const captured = capture(reader(values, reads));
  expect(captured("opaque.txt")).toBe("opaque");
  expect(captured("opaque.txt")).toBe("opaque");
  expect(reads).toEqual([...required, "opaque.txt"]);
  let coerced = 0;
  const bad = {
    toString() {
      coerced++;
      throw Error("coerced");
    },
  };
  expect(() => capture((path) => (path === allocations ? (bad as unknown as string) : disk(path)))).toThrow(
    "non-string source",
  );
  expect(() => capture(disk)("opaque.txt")).toThrow();
  expect(coerced).toBe(0);
});
it("R16 passes one private snapshot through unchanged class and type ownership with no physical rereads", () => {
  const reads: string[] = [];
  const current = capture(reader(snapshot(), reads));
  const classBefore = createIrNativeClassLayoutSourceReader(current);
  const result = readBeforeIrNativeAllocationTypeOwnership("src/ir/analysis/contracts/allocations.ts", classBefore);
  expect(typeof result).toBe("string");
  expect(reads).toEqual(required);
});
it("R17 exact B raw hook creates a new full capture on every invocation and rejects later drift", () => {
  const values = snapshot(),
    reads: string[] = [],
    actual = reader(values, reads);
  const raw = (path: string) =>
    readBeforeIrNativeAllocationTypeOwnership(path, createIrNativeClassLayoutSourceReader(capture(actual)));
  const first = raw("src/ir/analysis/contracts/allocations.ts");
  expect(reads).toEqual(required);
  reads.length = 0;
  expect(raw("src/ir/analysis/contracts/allocations.ts")).toBe(first);
  expect(reads).toEqual(required);
  values.set(allocations, values.get(allocations)! + "\n");
  expect(() => raw("src/ir/analysis/contracts/allocations.ts")).toThrow(`complete source pin ${allocations}`);
});
it("R18 rejects historical allocations supplied as current and pins every changed three-span region", () => {
  const values = snapshot();
  values.set(allocations, capture(disk)(allocations));
  expect(() => capture(reader(values))).toThrow(`complete source pin ${allocations}`);
  const transform = receipt.transforms.find((r) => r.path === allocations)!;
  expect(transform.edits).toHaveLength(3);
  for (const edit of transform.edits) {
    const mutant = snapshot(),
      old = mutant.get(allocations)!;
    mutant.set(allocations, old.slice(0, edit.currentStart) + "!" + old.slice(edit.currentStart + 1));
    expect(() => capture(reader(mutant))).toThrow(`complete source pin ${allocations}`);
  }
});

const gcPolicies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
function prepare(enabled: boolean, policy: (typeof gcPolicies)[number] = gcPolicies[0]) {
  const ast = analyzeMultiSource(
    { "./entry.ts": "export function run(x:number):number{const a=[x];return a[99]===a[99]?1:0;}" },
    "./entry.ts",
  );
  const source = sourceProducer.prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: gcPolicies,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (source.kind !== "prepared") throw Error(JSON.stringify(source));
  const result = prepareTypedIrProgram(sourceProducer.captureTypedIrProgramInput(source), {
    policy,
    runtimePolicies: gcPolicies,
    controls: {
      gvnMode: "off",
      ownership: enabled,
      escape: enabled,
      verifyIntermediateAllocations: true,
      verifyDominanceNaive: true,
    },
  });
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return result.program;
}
it.each([false, true])(
  "R19 authentic current GC source/live/codec joins with ownership controls %s",
  async (enabled) => {
    let validations = 0;
    for (const policy of gcPolicies) {
      const program = prepare(enabled, policy),
        encoded = encodePreparedIrProgram(program);
      const poison = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
        throw Error("source reconstruction forbidden");
      });
      try {
        for (const current of [program, decodePreparedIrProgram(encoded)]) {
          expect(assertNativeNumberUndefinedGcAllocations(current)).toBe(true);
          assertPreparedIrProgramAllocations(current);
          assertPreparedIrProgram(current);
          expect(encodePreparedIrProgram(current)).toBe(encoded);
          validations++;
        }
        expect(poison).not.toHaveBeenCalled();
      } finally {
        poison.mockRestore();
      }
      await yieldTurn();
    }
    expect(validations).toBe(4);
  },
  120000,
);
it("R20 legacy three-field context and non-GC or mixed views retain the generic evidence backstop", async () => {
  const program = prepare(false),
    legacy = { ir: program.ir, allocations: program.allocations, runtimeSupport: program.runtimeSupport };
  expect(assertNativeNumberUndefinedGcAllocations(legacy)).toBe(false);
  expect(() => assertPreparedIrProgramAllocations(legacy)).toThrow(/missing or stale ownership/);
  for (const views of [
    [],
    program.runtime.map((v) => ({ ...v, backend: "linear" as const })),
    program.runtime.map((v, i) => (i === 0 ? { ...v, backend: "linear" as const } : v)),
  ]) {
    const current = { ...program, runtime: views };
    expect(assertNativeNumberUndefinedGcAllocations(current)).toBe(false);
    expect(() => assertPreparedIrProgramAllocations(current)).toThrow(/missing or stale ownership/);
  }
  await yieldTurn();
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
  for (const fn of selected ? program.runtime[0]!.prepared.functions : program.ir.functions)
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
  "R21 actual GC malformed %s refuses before logical approval",
  async (kind) => {
    const program = mutable(prepare(false)),
      snapshot = program.allocations;
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
    const box = instructions(program, kind !== "originalType").find((instr) => instr.kind === "box")!;
    if (kind === "originalType" || kind === "selectedType")
      Object.assign(box, { resultType: { kind: "val", val: { kind: "i32" } } });
    if (kind === "selectedSSA") Object.assign(box, { value: box.result });
    if (kind === "selectedOrigin") Object.assign(box, { site: { line: 999, column: 1 } });
    const block = program.runtime[0]!.prepared.functions[0]!.blocks[0]!;
    if (kind === "selectedBlock") Object.assign(block, { id: 7 });
    if (kind === "selectedReturn") Object.assign(block.terminator, { values: [] });
    if (kind === "selectedTag") Object.assign(box, { toType: { kind: "dynamic", tag: 2 } });
    if (kind === "coverageAndInvalid") {
      Object.assign(program.ir, { functions: [] });
      Object.assign(block.terminator, { values: [] });
    }
    expect(() => assertNativeNumberUndefinedGcAllocations(program)).toThrow();
    expect(() => assertPreparedIrProgramAllocations(program)).toThrow();
    await yieldTurn();
  },
  120000,
);
it("R22 actual allocation DATA getter is refused without executing it", async () => {
  const program = mutable(prepare(false));
  let invoked = 0;
  Object.defineProperty(program.allocations, "metadata", {
    enumerable: true,
    get() {
      invoked++;
      throw Error("executed");
    },
  });
  expect(() => assertNativeNumberUndefinedGcAllocations(program)).toThrow();
  expect(invoked).toBe(0);
  await yieldTurn();
}, 120000);
it("R23 ordinary scalar source/live/codec remains genuine across four native projections", async () => {
  let validations = 0;
  for (const policy of [
    { backend: "wasmgc", target: "standalone" },
    { backend: "wasmgc", target: "wasi" },
    { backend: "linear", target: "standalone" },
    { backend: "linear", target: "wasi" },
  ] as const) {
    const ast = analyzeMultiSource({ "./entry.ts": "export function run(x:number):number{return x+7;}" }, "./entry.ts");
    const source = sourceProducer.prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    const result = prepareTypedIrProgram(sourceProducer.captureTypedIrProgramInput(source), {
      policy,
      runtimePolicies: [policy],
      controls: {
        gvnMode: "off",
        ownership: false,
        escape: false,
        verifyIntermediateAllocations: true,
        verifyDominanceNaive: true,
      },
    });
    if (result.kind !== "prepared") throw Error(JSON.stringify(result));
    const encoded = encodePreparedIrProgram(result.program);
    for (const program of [result.program, decodePreparedIrProgram(encoded)]) {
      expect(assertNativeNumberUndefinedGcAllocations(program)).toBe(false);
      assertPreparedIrProgramAllocations(program);
      assertPreparedIrProgram(program);
      expect(encodePreparedIrProgram(program)).toBe(encoded);
      validations++;
    }
    await yieldTurn();
  }
  expect(validations).toBe(8);
}, 120000);
