// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import {
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  emittedPhysicalSetupPlan,
} from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import { isNativeNumericAppendCall } from "../src/ir/analysis/allocation-evidence/numeric-append-protocol.js";
import { emitBinary } from "../src/emit/binary.js";
import * as sourceProducer from "../src/ir/program-source.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import type { PreparedIrProgram } from "../src/ir/program.js";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
function prepare(text: string, deferTopLevelInit = false, gcOnly = false) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: gcOnly ? policies[2] : policies[0],
    runtimePolicies: gcOnly ? [policies[2]] : policies,
    deferTopLevelInit,
    linearVectorProjection: "native-f64",
  });
}
function requireProgram(result: ReturnType<typeof prepare>): PreparedIrProgram {
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return result.program;
}
function emit(program: PreparedIrProgram, policy: (typeof policies)[number]) {
  const accepted = acceptPreparedIrProgram(program, {
    ...policy,
    moduleName: "zero-push",
    sourceMap: false,
    utf8Storage: false,
    sharedExceptionTag: false,
  });
  if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
  return emitAcceptedIrProgram(accepted);
}
function exportsOf(binary: Uint8Array<ArrayBuffer>, start = true) {
  expect(WebAssembly.validate(binary)).toBe(true);
  const module = new WebAssembly.Module(binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = new WebAssembly.Instance(module, {}).exports;
  if (start && exports._start) Reflect.apply(exports._start as Function, undefined, []);
  return exports;
}
function execute(exports: WebAssembly.Exports, values: Record<string, number>): number {
  for (const [name, value] of Object.entries(values))
    expect(Reflect.apply(exports[name] as Function, undefined, []), name).toBe(value);
  return Object.keys(values).length;
}
function nodeReference(text: string, names: readonly string[]): Record<string, number> {
  // This independent JavaScript reference executes the fixture's actual Array
  // methods before PreparedIR exists; it never emits or reconstructs Wasm.
  const javascript = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, Function> = {};
  new Function("exports", javascript)(exports);
  return Object.fromEntries(names.map((name) => [name, exports[name]!()]));
}
function instructions(program: PreparedIrProgram): IrInstr[] {
  const all: IrInstr[] = [];
  for (const fn of program.ir.functions)
    for (const block of fn.blocks) for (const root of block.instrs) forEachInstrDeep(root, (i) => all.push(i));
  return all;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

import {
  verifyNativeAllocationEvidence,
  hasStructuredNumericVectors,
} from "../src/ir/analysis/allocation-evidence/structured-vector-profile.js";
import { verifyAllocationEvidence } from "../src/ir/analysis/allocation-evidence/verify.js";
import { ALLOC_NAMESPACES } from "../src/ir/analysis/alloc-registry.js";
import { asValueId } from "../src/ir/core/nodes.js";
import { irVal } from "../src/ir/core/types.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
const math = (read: string) => `export function plain():number{const a=[2,5];const n=${read};return n*100+a[0]*10+a[1];}
export function empty():number{const a:number[]=[];return ${read};}
export function statement():number{const a=[2,5];${read};return a.length;}`;
let live: PreparedIrProgram;
beforeAll(() => {
  live = requireProgram(prepare(math("a.length")));
}, 120000);
it.each(["a.length", "a.push()"])(
  "executes genuine pure multiply %s on four profiles live/codec without source reconstruction or append resources",
  async (read) => {
    const text = math(read),
      values = nodeReference(text, ["plain", "empty", "statement"]);
    expect(values).toEqual({ plain: 225, empty: 0, statement: 2 });
    const program = requireProgram(prepare(text)),
      sealed = encodePreparedIrProgram(program);
    expect(hasStructuredNumericVectors(program.ir)).toBe(false);
    expect(instructions(program).some((i) => i.kind === "binary" && i.op === "f64.mul")).toBe(true);
    expect(instructions(program).some(isNativeNumericAppendCall)).toBe(false);
    expect(verifyAllocationEvidence(program.ir, program.allocations)).toMatchObject({
      kind: "not-covered",
      reason: "numeric-opcode",
    });
    expect(verifyNativeAllocationEvidence(program.ir, program.allocations)).toMatchObject({
      kind: "verified",
      namespaces: "ownership-and-escape",
    });
    const noSource = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
      throw Error("source reconstruction forbidden");
    });
    const noLinear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
      throw Error("direct Linear forbidden");
    });
    const noGc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw Error("direct WasmGC forbidden");
    });
    let executions = 0;
    for (const policy of policies) {
      const binaries: Uint8Array[] = [];
      for (const value of [program, decodePreparedIrProgram(sealed)]) {
        assertPreparedIrProgram(value);
        const emission = emit(value, policy),
          plan = emittedPhysicalSetupPlan(emission);
        expect(plan.vectors.numericAppendHelper).toBeUndefined();
        expect(plan.vectors.helper).toBeUndefined();
        expect(plan.vectors.demands.reduce((n, row) => n + row.uses.length, 0)).toBe(0);
        expect(plan.linearMemory?.functions.filter((fn) => fn.role === "append-f64") ?? []).toEqual([]);
        const binary = Uint8Array.from(emitBinary(emission.module));
        binaries.push(binary);
        executions += execute(exportsOf(binary), values);
        await yieldTurn();
      }
      expect(binaries[0]).toEqual(binaries[1]);
    }
    expect(executions).toBe(24);
    expect(noSource).not.toHaveBeenCalled();
    expect(noLinear).not.toHaveBeenCalled();
    expect(noGc).not.toHaveBeenCalled();
  },
  120000,
);
function changedInstruction(change: (i: IrInstr) => IrInstr) {
  return {
    ...live.ir,
    functions: live.ir.functions.map((fn) => ({
      ...fn,
      blocks: fn.blocks.map((b) => ({ ...b, instrs: b.instrs.map(change) })),
    })),
  };
}
it.each(["operand-type", "result-type", "future-operand", "duplicate-result"])(
  "native replay refuses genuine multiply %s contradiction",
  (kind) => {
    const module = changedInstruction((i) => {
      if (i.kind !== "binary" || i.op !== "f64.mul") return i;
      if (kind === "operand-type") return { ...i, lhs: asValueId(2) };
      if (kind === "result-type") return { ...i, resultType: irVal({ kind: "i32" }) };
      if (kind === "future-operand") return { ...i, lhs: asValueId(999999) };
      return { ...i, result: i.lhs };
    });
    expect(verifyNativeAllocationEvidence(module, live.allocations)).toMatchObject({
      kind: "invalid",
      code: "lexical-definition",
    });
  },
);
it.each(["site", "type", "state"])("native replay refuses allocation %s forgery", (kind) => {
  const registry = structuredClone(live.allocations);
  const entries = registry.entries.map((entry, index) => {
    if (index !== 0 || entry.state !== "live") return entry;
    if (kind === "site") return { ...entry, site: { ...entry.site, kind: "object" as const } };
    if (kind === "type") return { ...entry, site: { ...entry.site, type: irVal({ kind: "f64" }) } };
    return { state: "retired" as const };
  });
  expect(verifyNativeAllocationEvidence(live.ir, { ...registry, entries })).toMatchObject({
    kind: "invalid",
    code: "allocation-provenance",
  });
});
it.each([ALLOC_NAMESPACES.ownership, ALLOC_NAMESPACES.escape])(
  "prepared currentness refuses missing %s namespace",
  (namespace) => {
    const allocations = {
      ...live.allocations,
      metadata: live.allocations.metadata.map((row) => ({
        ...row,
        entries: row.entries.filter(([key]) => key !== namespace),
      })),
    };
    expect(() => assertPreparedIrProgram({ ...live, allocations })).toThrow(PreparedIrProgramInvariantError);
  },
);
it("prepared currentness refuses contradictory complete ownership evidence", () => {
  const allocations = {
    ...live.allocations,
    metadata: live.allocations.metadata.map((row) => ({
      ...row,
      entries: row.entries.map(
        ([key, value]) => [key, key === ALLOC_NAMESPACES.ownership ? { state: "owned", ops: [] } : value] as const,
      ),
    })),
  };
  expect(verifyNativeAllocationEvidence(live.ir, allocations)).toMatchObject({
    kind: "invalid",
    code: "namespace-value",
  });
  expect(() => assertPreparedIrProgram({ ...live, allocations })).toThrow(PreparedIrProgramInvariantError);
});
it("prepared attachment currentness refuses stale facts", () => {
  expect(() =>
    assertPreparedIrProgram({
      ...live,
      linearAllocationFacts: {
        ...live.linearAllocationFacts!,
        facts: { ...live.linearAllocationFacts!.facts, allocations: [] },
      },
    }),
  ).toThrow(PreparedIrProgramInvariantError);
});
it.each(["sub", "div"])("native finite selector keeps neighboring f64.%s unsupported", (op) => {
  const result = prepare(
    math("a.length").replace("n*100", op === "sub" ? "n-100" : op === "div" ? "n/100" : "Math.min(n,100)"),
  );
  expect(result.kind).toBe("unsupported");
});
it("scalar-only and scalar sibling multiplication do not trigger native vector coverage", () => {
  const scalar = requireProgram(prepare("export function scalar(x:number):number{return x*100;}"));
  expect(verifyNativeAllocationEvidence(scalar.ir, scalar.allocations)).toMatchObject({
    kind: "not-covered",
    reason: "numeric-opcode",
  });
  const result = prepare(
    "export function scalar(x:number):number{return x*100;} export function vector():number{const a=[2,5];return a.length;}",
  );
  expect(result.kind).toBe("unsupported");
});

it("public compile executes actual length and zero-push multiply on four profiles with direct generators forbidden", async () => {
  const noLinear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct Linear forbidden");
  });
  const noGc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct WasmGC forbidden");
  });
  let executions = 0;
  for (const read of ["a.length", "a.push()"])
    for (const policy of policies) {
      const text = math(read),
        values = nodeReference(text, ["plain", "empty", "statement"]);
      const result = await compile(text, { ...policy, optimize: false, sourceMap: false });
      expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
      executions += execute(exportsOf(Uint8Array.from(result.binary)), values);
      await yieldTurn();
    }
  expect(executions).toBe(24);
  expect(noLinear).not.toHaveBeenCalled();
  expect(noGc).not.toHaveBeenCalled();
}, 120000);

import * as nativeEvidence from "../src/ir/analysis/allocation-evidence/structured-vector-profile.js";
it("healthy scalar artifact stays byte-equal to historical native dispatch on all four profiles", () => {
  const text = "export function scalar(x:number):number{return x*100;}";
  const current = requireProgram(prepare(text));
  const dispatch = vi
    .spyOn(nativeEvidence, "verifyNativeAllocationEvidence")
    .mockImplementation((module, registry, globals) =>
      hasStructuredNumericVectors(module)
        ? nativeEvidence.verifyStructuredNumericVectorEvidence(module, registry, globals)
        : verifyAllocationEvidence(module, registry),
    );
  const historical = requireProgram(prepare(text));
  dispatch.mockRestore();
  expect(encodePreparedIrProgram(current)).toEqual(encodePreparedIrProgram(historical));
  let executions = 0;
  for (const policy of policies) {
    const binaries = [current, historical].map((program) => Uint8Array.from(emitBinary(emit(program, policy).module)));
    expect(binaries[0]).toEqual(binaries[1]);
    for (const binary of binaries) {
      expect(Reflect.apply(exportsOf(binary).scalar as Function, undefined, [3])).toBe(300);
      executions++;
    }
  }
  expect(executions).toBe(8);
});

it.each(["foreign-arm-value", "condition-carrier"])("scalar bounds-check scope rejects %s", (kind) => {
  const module = changedInstruction((i) =>
    i.kind !== "if"
      ? i
      : kind === "foreign-arm-value"
        ? { ...i, thenValue: i.elseValue }
        : { ...i, cond: asValueId(2) },
  );
  expect(verifyNativeAllocationEvidence(module, live.allocations)).toMatchObject({
    kind: "invalid",
    code: "lexical-definition",
  });
});
it("currentness rechecks all runtime views after a successful warm acquisition", () => {
  assertPreparedIrProgram(live);
  const view = live.runtime[0]!;
  const runtime = live.runtime.map((v, index) =>
    index === 0
      ? {
          ...v,
          prepared: {
            ...view.prepared,
            functions: view.prepared.functions.map((fn) => ({ ...fn, name: "foreign-currentness-name" })),
          },
        }
      : v,
  );
  expect(() => assertPreparedIrProgram({ ...live, runtime })).toThrow(PreparedIrProgramInvariantError);
  expect(() => encodePreparedIrProgram({ ...live, runtime })).toThrow(PreparedIrProgramInvariantError);
});

it("finite arithmetic scheduling does not admit foreign reference constants", () => {
  const functions = live.ir.functions.map((fn, index) =>
    index !== 0
      ? fn
      : {
          ...fn,
          valueCount: fn.valueCount + 1,
          blocks: fn.blocks.map((b) => ({
            ...b,
            instrs: [
              ...b.instrs,
              {
                kind: "const" as const,
                result: asValueId(fn.valueCount),
                resultType: irVal({ kind: "externref" }),
                value: { kind: "null" as const, ty: irVal({ kind: "externref" }) },
              },
            ],
          })),
        },
  );
  expect(verifyNativeAllocationEvidence({ ...live.ir, functions }, live.allocations)).toMatchObject({
    kind: "not-covered",
  });
});
it("finite arithmetic scheduling refuses allocations inside scalar bounds-check arms", () => {
  const allocation = instructions(live).find((i) => i.kind === "vec.new_fixed")!;
  const module = changedInstruction((i) => (i.kind !== "if" ? i : { ...i, then: [allocation, ...i.then] }));
  expect(verifyNativeAllocationEvidence(module, live.allocations)).toMatchObject({ kind: "not-covered" });
});
