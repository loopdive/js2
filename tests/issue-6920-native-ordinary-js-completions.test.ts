// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { prepareIrProgramAbiEntries } from "../src/ir/program-abi-contracts.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program/validation.js";
import { verifyIrFunction } from "../src/ir/runtime/verify.js";
import { forEachInstrDeep, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import { JS_TAG_IDS } from "../src/ir/core/js-value-tag-identities.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { analyzeOwnership } from "../src/ir/analysis/ownership.js";
import { analyzeEscape } from "../src/ir/analysis/escape.js";
import { findStackAllocCandidates } from "../src/ir/analysis/stack-alloc.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import * as completions from "../src/ir/source-function-completions.js";

import { IrFunctionBuilder } from "../src/ir/builder.js";
import type { IrType } from "../src/ir/core/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
type Policy = (typeof policies)[number];
const fixtures = [
  {
    name: "public void annotation actual Number",
    files: {
      "./entry.ts": "export function run():void{return 4 as never;}",
    },
    expected: 4,
    helper: "run",
    dynamic: true,
  },
  {
    name: "used helper",
    files: {
      "./entry.ts":
        "function effect():void{return 4 as never;}export function run():number{return effect()===undefined?1:0;}",
    },
    expected: 0,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "discarded once",
    files: {
      "./entry.ts":
        "let count:number=0;function effect():void{count=count+1;return 4 as never;}export function run():number{effect();return count;}",
    },
    expected: 1,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "bare void unchanged",
    files: {
      "./entry.ts": "export function run():void{return;}",
    },
    expected: "Undefined",
    helper: "run",
    dynamic: false,
  },
  {
    name: "scalar Number unchanged",
    files: {
      "./entry.ts": "export function run():number{return 4;}",
    },
    expected: 4,
    helper: "run",
    dynamic: false,
  },
  {
    name: "mixed bare and valued",
    files: {
      "./entry.ts":
        "function effect(x:number):void{if(x)return 4 as never;return;}export function run():number{return effect(0)===undefined?1:0;}",
    },
    expected: 1,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "Boolean payload",
    files: {
      "./entry.ts":
        "function effect():void{return true as never;}export function run():number{return effect()===undefined?1:0;}",
    },
    expected: 0,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "NaN payload",
    files: {
      "./entry.ts":
        "function effect():void{return (0/0) as never;}export function run():number{return effect()===undefined?1:0;}",
    },
    expected: 0,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "negative-zero payload",
    files: {
      "./entry.ts":
        "function effect():void{return -0 as never;}export function run():number{return effect()===undefined?1:0;}",
    },
    expected: 0,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "helper chain",
    files: {
      "./entry.ts":
        "function leaf():void{return 4 as never;}function effect():void{return leaf();}export function run():number{return effect()===undefined?1:0;}",
    },
    expected: 0,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "import alias",
    files: {
      "./entry.ts": 'import {effect as h} from "./helper.js";export function run():number{return h()===undefined?1:0;}',
      "./helper.ts": "export function effect():void{return 4 as never;}",
    },
    expected: 0,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "if statement",
    files: {
      "./entry.ts":
        "function effect(x:number):void{if(x){return 4 as never;}return 5 as never;}export function run():number{effect(1);return 0;}",
    },
    expected: 0,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "labeled block",
    files: {
      "./entry.ts":
        "function effect(x:number):void{label:{if(x){return 4 as never;}}return 5 as never;}export function run():number{effect(1);return 0;}",
    },
    expected: 0,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "numeric switch",
    files: {
      "./entry.ts":
        "function effect(x:number):void{switch(x){case 1:return 4 as never;default:return 5 as never;}}export function run():number{effect(1);return 0;}",
    },
    expected: 0,
    helper: "effect",
    dynamic: true,
  },
  {
    name: "ordinary abrupt alternate",
    files: {
      "./entry.ts":
        "function effect(x:number):void{if(x)throw 7;return 4 as never;}export function run():number{effect(1);return 0;}",
    },
    expected: "throw7",
    helper: "effect",
    dynamic: true,
  },
  {
    name: "explicit void operand once",
    files: {
      "./entry.ts":
        "let count:number=0;function bump():number{count=count+1;return 4;}function effect():void{return void bump();}export function run():number{effect();return count;}",
    },
    expected: 1,
    helper: "effect",
    dynamic: true,
  },
] as const;
type Fixture = Omit<(typeof fixtures)[number], "files"> & { readonly files: Readonly<Record<string, string>> };
afterEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
});
function ops(fn: IrFunction): IrInstr[] {
  const found: IrInstr[] = [];
  for (const block of fn.blocks)
    for (const instruction of block.instrs) forEachInstrDeep(instruction, (child) => found.push(child));
  return found;
}
function source(files: Record<string, string>, policy: Policy | { backend: "wasmgc"; target: "host" }) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  const result = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: [policy],
    deferTopLevelInit: false,
  });
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  return { ast, result, input: captureTypedIrProgramInput(result) };
}
function oracle(fixture: Fixture): unknown {
  const cache = new Map<string, Record<string, unknown>>();
  const load = (path: string): Record<string, unknown> => {
    if (cache.has(path)) return cache.get(path)!;
    const exports: Record<string, unknown> = {};
    cache.set(path, exports);
    const files: Record<string, string> = fixture.files;
    const code = ts.transpileModule(files[path]!, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    new Function("exports", "require", code)(exports, (id: string) => load(id.replace(/\.js$/, ".ts")));
    return exports;
  };
  try {
    return (load("./entry.ts").run as () => unknown)();
  } catch (error) {
    if (fixture.expected !== "throw7") throw error;
    return `throw${error}`;
  }
}
function abiAndCalls(input: ReturnType<typeof captureTypedIrProgramInput>): void {
  const entries = prepareIrProgramAbiEntries(input);
  for (const fn of input.ir.functions) {
    expect(verifyIrFunction(fn)).toEqual([]);
    const contract = entries.find(
      (row) =>
        row.contract.kind === "callable" &&
        row.contract.ref.binding.kind === "unit" &&
        row.contract.ref.binding.unitId === fn.unitId,
    )?.contract;
    if (contract?.kind !== "callable") throw new Error("actual body has no canonical callable ABI");
    expect(contract.params).toEqual(fn.params.map((param) => param.type));
    expect(contract.results).toEqual(fn.resultTypes);
    for (const call of ops(fn))
      if (call.kind === "call" && call.target.binding.kind === "unit") {
        const unitId = call.target.binding.unitId;
        const callee = input.ir.functions.find((candidate) => candidate.unitId === unitId);
        if (!callee) throw new Error("missing authentic call target");
        expect(call.resultType ?? null).toEqual(callee.resultTypes[0] ?? null);
      }
  }
}
function checkBoxes(fn: IrFunction, snapshot: ReturnType<typeof captureTypedIrProgramInput>["allocations"]): void {
  const registry = AllocSiteRegistry.fromSnapshot(snapshot),
    ownership = analyzeOwnership(fn, registry),
    escapeResult = analyzeEscape(fn, registry, ownership);
  const stack = findStackAllocCandidates(fn, undefined, ownership);
  for (const instruction of ops(fn))
    if (instruction.kind === "early.return" && instruction.value !== null) {
      const returned = ops(fn).find((row) => row.result === instruction.value);
      if (returned?.kind !== "box") continue;
      expect(returned.alloc).toBeDefined();
      expect(ownership.of(returned.result!).ownership).toBe("escaped");
      expect(ownership.of(returned.result!).access.has("escape")).toBe(true);
      expect(escapeResult.of(returned.result!)?.classification).not.toBe("local");
      expect(escapeResult.of(returned.result!)?.stackAllocatable).toBe(false);
      expect(stack.some((row) => row.allocId === returned.alloc)).toBe(false);
      expect(registry.read(returned.alloc!, "ownership")).not.toHaveProperty("stackCandidate");
    }
}
function payload(fn: IrFunction, id: number): number {
  const instruction = ops(fn).find((row) => row.result === id);
  if (instruction?.kind === "const" && instruction.value.kind === "f64") return instruction.value.value;
  if (instruction?.kind === "unary" && instruction.op === "f64.neg") return -payload(fn, instruction.rand);
  if (instruction?.kind === "binary" && instruction.op === "f64.div")
    return payload(fn, instruction.lhs) / payload(fn, instruction.rhs);
  throw new Error("payload must retain genuine constant or original arithmetic");
}
function observations(
  fixture: Fixture,
  input: ReturnType<typeof captureTypedIrProgramInput>,
  phase: "source" | "decoded" = "source",
): void {
  const fn = input.ir.functions.find((row) => row.name === fixture.helper)!;
  expect(fn).toBeDefined();
  expect(fn.resultTypes).toEqual(
    fixture.dynamic
      ? [{ kind: "dynamic" }]
      : fixture.name === "bare void unchanged"
        ? []
        : [{ kind: "val", val: { kind: "f64" } }],
  );
  if (fixture.name === "NaN payload" || fixture.name === "negative-zero payload") {
    const ret = ops(fn).find((row) => row.kind === "early.return");
    if (ret?.kind !== "early.return") throw new Error("missing real return");
    const box = ops(fn).find((row) => row.result === ret.value);
    if (box?.kind !== "box") throw new Error("missing genuine box");
    const actual = payload(fn, box.value);
    expect(fixture.name === "NaN payload" ? Number.isNaN(actual) : Object.is(actual, -0)).toBe(true);
  }
  if (fixture.name === "Boolean payload") {
    const box = ops(fn).find((row) => row.kind === "box");
    if (box?.kind !== "box") throw new Error("missing Boolean box");
    expect(box.toType).toEqual({ kind: "dynamic", tag: JS_TAG_IDS.Boolean });
    const constant = ops(fn).find((row) => row.result === box.value);
    expect(constant?.kind === "const" && constant.value).toEqual({ kind: "bool", value: true });
  }
  if (
    [
      "public void annotation actual Number",
      "used helper",
      "discarded once",
      "mixed bare and valued",
      "helper chain",
      "import alias",
      "if statement",
      "labeled block",
      "numeric switch",
      "ordinary abrupt alternate",
    ].includes(fixture.name)
  ) {
    const actual: number[] = [];
    for (const candidate of input.ir.functions.filter((row) => row.name === fixture.helper || row.name === "leaf"))
      for (const ret of ops(candidate))
        if (ret.kind === "early.return") {
          const value = ops(candidate).find((row) => row.result === ret.value);
          if (value?.kind === "box" && value.toType.kind === "dynamic" && value.toType.tag === JS_TAG_IDS.NumberF64)
            actual.push(payload(candidate, value.value));
        }
    expect(actual.sort((a, b) => a - b)).toEqual(
      ["if statement", "labeled block", "numeric switch"].includes(fixture.name) ? [4, 5] : [4],
    );
  }
  if (fixture.name === "scalar Number unchanged") {
    const ret = fn.blocks.find((block) => block.terminator.kind === "return")!.terminator;
    if (ret.kind !== "return") throw new Error("genuine scalar return absent");
    expect(payload(fn, ret.values[0]!)).toBe(4);
  }
  const required = { "if statement": "if.stmt", "labeled block": "labeled.block", "numeric switch": "switch" }[
    fixture.name as "if statement" | "labeled block" | "numeric switch"
  ];
  if (required) {
    expect(ops(fn).some((row) => row.kind === required)).toBe(true);
    expect(ops(fn).filter((row) => row.kind === "box").length).toBeGreaterThanOrEqual(2);
  }
  if (fixture.name === "discarded once" || fixture.name === "explicit void operand once") {
    const effect = input.ir.functions.find((row) => row.name === "effect")!,
      bump = input.ir.functions.find((row) => row.name === "bump") ?? effect;
    const run = input.ir.functions.find((row) => row.name === "run")!;
    expect(
      ops(run).filter(
        (row) =>
          row.kind === "call" && row.target.binding.kind === "unit" && row.target.binding.unitId === effect.unitId,
      ),
    ).toHaveLength(1);
    if (phase === "source" && bump !== effect)
      expect(
        ops(effect).filter(
          (row) =>
            row.kind === "call" && row.target.binding.kind === "unit" && row.target.binding.unitId === bump.unitId,
        ),
      ).toHaveLength(1);
    const writes: { fn: IrFunction; instruction: Extract<IrInstr, { kind: "global.set" }> }[] = [];
    const visit = (current: IrFunction, active: Set<IrFunction>): void => {
      if (active.has(current)) throw new Error("unexpected cycle in genuine once fixture");
      const next = new Set(active).add(current);
      for (const row of ops(current)) {
        if (row.kind === "global.set") writes.push({ fn: current, instruction: row });
        if (row.kind === "call" && row.target.binding.kind === "unit") {
          const binding = row.target.binding;
          const callee = input.ir.functions.find((candidate) => candidate.unitId === binding.unitId);
          if (!callee) throw new Error("actual once fixture callee body absent");
          visit(callee, next);
        }
      }
    };
    visit(run, new Set());
    expect(writes).toHaveLength(1);
    const write = writes[0]!;
    const increment = ops(write.fn).find((row) => row.result === write.instruction.value);
    if (increment?.kind !== "binary" || increment.op !== "f64.add")
      throw new Error("actual count increment opcode missing");
    expect(payload(write.fn, increment.rhs)).toBe(1);
    const read = ops(write.fn).find((row) => row.result === increment.lhs);
    if (read?.kind !== "global.get") throw new Error("real increment global read absent");
    expect(write.instruction.target).toEqual(read.target);
    const completions = run.blocks.filter((block) => block.terminator.kind === "return");
    expect(completions).toHaveLength(1);
    const completion = completions[0]!.terminator;
    if (completion.kind !== "return" || completion.values.length !== 1)
      throw new Error("actual count return operand absent");
    const returned = ops(run).find((row) => row.result === completion.values[0]);
    if (returned?.kind !== "global.get") throw new Error("actual count observable absent");
    expect(returned.target).toEqual(read.target);
  }
  if (fixture.name === "explicit void operand once") {
    const completion = ops(fn).find((row) => row.kind === "early.return");
    if (completion?.kind !== "early.return") throw new Error("actual void completion absent");
    const actual = ops(fn).find((row) => row.result === completion.value);
    expect(actual?.kind === "const" && actual.value).toEqual({ kind: "undefined" });
    expect(actual?.resultType).toEqual({ kind: "dynamic", tag: JS_TAG_IDS.Undefined });
  }
  if (fixture.name === "ordinary abrupt alternate") {
    expect(ops(fn).some((row) => row.kind === "intrinsic" && row.id === "js.number.box")).toBe(true);
    expect(ops(fn).some((row) => row.kind === "throw")).toBe(true);
  }
  abiAndCalls(input);
  for (const fn of input.ir.functions) checkBoxes(fn, input.allocations);
}
function typed(input: ReturnType<typeof captureTypedIrProgramInput>, policy: Policy) {
  const result = prepareTypedIrProgram(input, {
    policy,
    runtimePolicies: [policy],
    controls: {
      gvnMode: "off",
      ownership: true,
      escape: true,
      verifyIntermediateAllocations: true,
      verifyDominanceNaive: true,
    },
  });
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  return result.program;
}
it.each(fixtures.flatMap((fixture) => policies.map((policy) => ({ fixture, policy }))))(
  "preserves actual $fixture.name on $policy.backend:$policy.target",
  async ({ fixture, policy }) => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(oracle(fixture)).toBe(fixture.expected === "Undefined" ? undefined : fixture.expected);
    const { input } = source(fixture.files, policy);
    observations(fixture, input);
  },
);
it.each(
  fixtures.filter((fixture) => !fixture.dynamic).flatMap((fixture) => policies.map((policy) => ({ fixture, policy }))),
)("typed scalar control $fixture.name on $policy.backend:$policy.target", ({ fixture, policy }) => {
  const { input } = source(fixture.files, policy);
  const program = typed(input, policy);
  assertPreparedIrProgram(program);
  const bytes = encodePreparedIrProgram(program),
    decoded = decodePreparedIrProgram(bytes);
  expect(encodePreparedIrProgram(decoded)).toBe(bytes);
  for (const module of [program.ir, decoded.ir]) for (const fn of module.functions) checkBoxes(fn, program.allocations);
  observations(
    fixture,
    {
      ...input,
      ir: decoded.ir,
      derivedUnits: decoded.derivedUnits,
      allocations: decoded.allocations,
    },
    "decoded",
  );
  for (const runtime of decoded.runtime)
    for (const fn of runtime.prepared.functions) checkBoxes(fn, decoded.allocations);
});

it.each(
  fixtures
    .filter((fixture) => fixture.dynamic && fixture.name !== "ordinary abrupt alternate")
    .flatMap((fixture) =>
      policies.filter((policy) => policy.backend === "wasmgc").map((policy) => ({ fixture, policy })),
    ),
)("typed GC completion $fixture.name on $policy.backend:$policy.target", ({ fixture, policy }) => {
  const { input } = source(fixture.files, policy);
  const program = typed(input, policy);
  assertPreparedIrProgram(program);
  const bytes = encodePreparedIrProgram(program),
    decoded = decodePreparedIrProgram(bytes);
  expect(encodePreparedIrProgram(decoded)).toBe(bytes);
  for (const fn of decoded.ir.functions) checkBoxes(fn, decoded.allocations);
  observations(
    fixture,
    {
      ...input,
      ir: decoded.ir,
      derivedUnits: decoded.derivedUnits,
      allocations: decoded.allocations,
    },
    "decoded",
  );
  for (const runtime of decoded.runtime) {
    for (const fn of runtime.prepared.functions) checkBoxes(fn, decoded.allocations);
    if (fixture.name === "used helper") {
      const helper = decoded.ir.functions.find((fn) => fn.name === "effect")!,
        selectedRun = runtime.prepared.functions.find((fn) => fn.name === "run")!;
      expect(
        ops(selectedRun).filter(
          (row) =>
            row.kind === "call" && row.target.binding.kind === "unit" && row.target.binding.unitId === helper.unitId,
        ),
      ).toHaveLength(1);
    }
  }
});

it.each(
  ["(void bump())", "void (void bump())"].flatMap((expression) => policies.map((policy) => ({ expression, policy }))),
)(
  "retains genuine Undefined and once effect for $expression on $policy.backend:$policy.target",
  ({ expression, policy }) => {
    const base = fixtures.find((fixture) => fixture.name === "explicit void operand once")!;
    const fixture = {
      ...base,
      files: { "./entry.ts": base.files["./entry.ts"]!.replace("return void bump();", `return ${expression};`) },
    };
    expect(oracle(fixture)).toBe(1);
    const { input } = source(fixture.files, policy);
    observations(fixture, input);
    if (policy.backend === "wasmgc") {
      const program = typed(input, policy);
      assertPreparedIrProgram(program);
      const bytes = encodePreparedIrProgram(program);
      const decoded = decodePreparedIrProgram(bytes);
      expect(encodePreparedIrProgram(decoded)).toBe(bytes);
      observations(
        fixture,
        { ...input, ir: decoded.ir, derivedUnits: decoded.derivedUnits, allocations: decoded.allocations },
        "decoded",
      );
    }
  },
);

function contract(text: string, policy: Policy | { backend: "wasmgc"; target: "host" } = policies[0]) {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts"),
    inventory = buildIrUnitInventory(ast.sourceFiles, { checker: ast.checker, entrySource: ast.entryFile }),
    identity = buildIrPlanningIdentityContext(inventory);
  const fn = ast.entryFile.statements.find(ts.isFunctionDeclaration)!;
  const signature = completions.sourceCompletionSignature(fn, null, { checker: ast.checker, identity, policy });
  const options = {
    identityContext: identity,
    checker: ast.checker,
    ownerUnitId: identity.unitIdByDeclaration.get(fn)!,
    returnTypeOverride: signature.bodyResult,
  };
  return { ast, fn, signature, identity, options };
}
it.each(["function inner():number{return 4;}", "class Inner{m(){return 4;}}"])(
  "ignores nested own-return census %s",
  (body) => {
    const row = contract(`function outer():void{${body}}export function run():void{outer();}`);
    expect(row.signature.bodyResult).toBeNull();
  },
);
it("preserves host signature and direct host lowering selection", () => {
  const row = contract("export function run():void{return 4 as never;}", { backend: "wasmgc", target: "host" });
  expect(row.signature.bodyResult).toBeNull();
  expect(completions.ordinaryCompletionMode(row.fn, { kind: "dynamic" }, row.options)).toBe(false);
});
it("does not widen authoritative scalar or managed contracts", () => {
  const row = contract("export function run():void{return 4 as never;}");
  for (const result of [
    { kind: "val", val: { kind: "f64" } },
    { kind: "val", val: { kind: "externref" } },
  ] as const)
    expect(
      completions.sourceCompletionSignature(row.fn, result, {
        checker: row.ast.checker,
        identity: row.identity,
        policy: policies[0],
      }).bodyResult,
    ).toBe(result);
  expect(completions.ordinaryCompletionMode(row.fn, { kind: "val", val: { kind: "f64" } }, row.options)).toBe(false);
  expect(() => completions.ordinaryCompletionMode(row.fn, row.signature.bodyResult, row.options)).toThrow();
});
it.each([
  "foreign checker",
  "foreign unit",
  "changed source",
  "repeated prepare",
  "missing identity",
  "missing owner",
  "missing checker",
  "changed result",
])("rechecks current source contract: %s", (change) => {
  const row = contract("export function run():void{return 4 as never;}");
  expect(completions.ordinaryCompletionMode(row.fn, row.signature.bodyResult, row.options)).toBe(true);
  if (change === "missing identity")
    expect(() =>
      completions.ordinaryCompletionMode(row.fn, row.signature.bodyResult, {
        ...row.options,
        identityContext: undefined,
      }),
    ).toThrow();
  else if (change === "missing owner")
    expect(() =>
      completions.ordinaryCompletionMode(row.fn, row.signature.bodyResult, {
        ...row.options,
        ownerUnitId: undefined as never,
      }),
    ).toThrow();
  else if (change === "missing checker")
    expect(() =>
      completions.ordinaryCompletionMode(row.fn, row.signature.bodyResult, { ...row.options, checker: undefined }),
    ).toThrow();
  else if (change === "changed result")
    expect(() => completions.ordinaryCompletionMode(row.fn, { kind: "dynamic" }, row.options)).toThrow();
  else if (change === "foreign checker") {
    const foreign = analyzeMultiSource(
      { "./entry.ts": "export function run():void{return 4 as never;}" },
      "./entry.ts",
    );
    expect(() => completions.assertCurrent(row.fn, { ...row.options, checker: foreign.checker })).toThrow();
  } else if (change === "foreign unit")
    expect(() =>
      completions.assertCurrent(row.fn, { ...row.options, ownerUnitId: "foreign" as typeof row.options.ownerUnitId }),
    ).toThrow();
  else if (change === "changed source") {
    Object.assign(row.fn.body!, { statements: ts.factory.createNodeArray([]) });
    expect(() => completions.assertCurrent(row.fn, row.options)).toThrow();
  } else {
    const other = contract("export function run():void{return 4 as never;}");
    expect(() => completions.ordinaryCompletionMode(row.fn, row.signature.bodyResult, other.options)).toThrow();
    expect(() => completions.assertCurrent(other.fn, row.options)).toThrow();
  }
});
it("never replaces an expression with no raw value by Undefined", () => {
  const { fn } = contract("export function run():void{return 4 as never;}");
  const statement = fn.body!.statements[0];
  if (!ts.isReturnStatement(statement)) throw new Error("actual return missing");
  expect(() => completions.ordinaryCompletionValue(statement, null as never, { kind: "dynamic" }, undefined)).toThrow(
    /did not produce/,
  );
});
it.each(["try{return 4 as never;}finally{let x=1;}", "for(const x of [1]){return 4 as never;}"])(
  "retains authentic cleanup/refusal frontier %s",
  (body) => {
    const ast = analyzeMultiSource({ "./entry.ts": `export function run():void{${body}}` }, "./entry.ts");
    const result = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: policies[0],
      runtimePolicies: [policies[0]],
      deferTopLevelInit: false,
    });
    expect(result.kind).toBe("unsupported");
  },
);
it.each([
  "body result",
  "return operand",
  "call result",
  "box tag",
  "allocation metadata",
  "call target",
  "selected result",
  "selected return",
  "allocation site",
])("independently refuses changed actual %s", (change) => {
  const { input } = source(fixtures[1]!.files, policies[0]),
    program = typed(input, policies[0]),
    mutant = structuredClone(program),
    helper = mutant.ir.functions.find((fn) => fn.name === "effect")!;
  if (change === "body result") Object.assign(helper, { resultTypes: [] });
  else if (change === "return operand") {
    const ret = ops(helper).find((row) => row.kind === "early.return")!;
    Object.assign(ret, { value: 987654 });
  } else if (change === "call result") {
    const call = ops(mutant.ir.functions.find((fn) => fn.name === "run")!).find((row) => row.kind === "call")!;
    Object.assign(call, { resultType: null, result: null });
  } else if (change === "call target") {
    const call = ops(mutant.ir.functions.find((fn) => fn.name === "run")!).find((row) => row.kind === "call")!;
    if (call.kind !== "call") throw new Error("genuine call absent");
    Object.assign(call.target.binding, { unitId: "foreign-unit" });
  } else if (change === "selected result" || change === "selected return") {
    const selected = mutant.runtime[0]!.prepared.functions.find((fn) => fn.unitId === helper.unitId)!;
    if (!selected) throw new Error("actual selected body absent");
    if (change === "selected result") Object.assign(selected, { resultTypes: [] });
    else {
      const ret = ops(selected).find((row) => row.kind === "early.return")!;
      Object.assign(ret, { value: 987654 });
    }
  } else if (change === "allocation site") {
    const box = ops(helper).find((row) => row.kind === "box")!;
    Object.assign(box, { alloc: 987654 });
  } else if (change === "box tag") {
    const box = ops(helper).find((row) => row.kind === "box")!;
    Object.assign(box, { toType: { kind: "dynamic", tag: JS_TAG_IDS.Boolean } });
  } else {
    const box = ops(helper).find((row) => row.kind === "box")!;
    const metadata = mutant.allocations.metadata.find((row) => row.id === box.alloc)!;
    const entry = metadata.entries.find((row) => row[0] === "ownership")!;
    Object.assign(entry[1] as object, { state: "owned", ops: [], stackCandidate: true });
  }
  expect(() => assertPreparedIrProgram(mutant)).toThrow();
});
it.each(policies.filter((policy) => policy.backend === "wasmgc"))(
  "codec and preparation are source-free after genuine capture on $backend:$target",
  (policy) => {
    const { ast, input } = source(fixtures[1]!.files, policy);
    for (const sf of ast.sourceFiles)
      for (const key of ["text", "statements"])
        Object.defineProperty(sf, key, {
          get() {
            throw new Error("post-capture AST read");
          },
        });
    const program = typed(input, policy),
      bytes = encodePreparedIrProgram(program);
    expect(encodePreparedIrProgram(decodePreparedIrProgram(bytes))).toBe(bytes);
  },
);

it.each(["symbolic f64", "sentinel f64", "symbol-branded f64", "Boolean-symbol conflict"])(
  "refuses unsupported actual return carrier %s",
  (change) => {
    const row = contract("export function run():void{return 4 as never;}");
    const statement = row.fn.body!.statements[0];
    if (!ts.isReturnStatement(statement)) throw new Error("missing original return");
    const identities = createTestIrFunctionIdentityFactory("ordinary-completion-carrier-negative");
    const builder = new IrFunctionBuilder(
      identities.next("carrier"),
      [{ kind: "dynamic" }],
      false,
      new AllocSiteRegistry(),
    );
    builder.openBlock();
    const type: IrType =
      change === "Boolean-symbol conflict"
        ? { kind: "val", val: { kind: "i32", boolean: true, symbol: true } }
        : change === "symbolic f64"
          ? { kind: "val", val: { kind: "f64" }, typeRef: {} as never }
          : change === "sentinel f64"
            ? { kind: "val", val: { kind: "f64", undefSentinel: true } }
            : { kind: "val", val: { kind: "f64", symbol: true } as never };
    const raw = builder.emitConst({ kind: "f64", value: 4 }, type);
    expect(() => completions.ordinaryCompletionValue(statement, builder, row.signature.bodyResult, raw)).toThrow(
      /actual return carrier/,
    );
  },
);
it.each(policies)("keeps original constructor managed self on $backend:$target", (policy) => {
  const { input } = source(
    { "./entry.ts": "class C{x:number=3;constructor(){}}export function run(){return new C().x===undefined?1:0;}" },
    policy,
  );
  const ctor = input.ir.functions.find((fn) => fn.sourceClassBody?.sourceBodyKind === "constructor")!;
  expect(ctor.resultTypes).toHaveLength(1);
  expect(ctor.resultTypes[0]?.kind).toBe("support-ref");
  expect(ops(ctor).some((row) => row.kind === "js.class.constructor.complete")).toBe(true);
});

it("revokes a prior source contract when the same original owner is replanned", () => {
  const row = contract("export function run():void{return 4 as never;}");
  expect(completions.ordinaryCompletionMode(row.fn, row.signature.bodyResult, row.options)).toBe(true);
  const host = completions.sourceCompletionSignature(row.fn, null, {
    checker: row.ast.checker,
    identity: row.identity,
    policy: { backend: "wasmgc", target: "host" },
  });
  expect(host.bodyResult).toBeNull();
  expect(() => completions.ordinaryCompletionMode(row.fn, row.signature.bodyResult, row.options)).toThrow();
  expect(completions.ordinaryCompletionMode(row.fn, null, { ...row.options, returnTypeOverride: null })).toBe(false);
  const next = completions.sourceCompletionSignature(row.fn, null, {
    checker: row.ast.checker,
    identity: row.identity,
    policy: policies[0],
  });
  expect(
    completions.ordinaryCompletionMode(row.fn, next.bodyResult, {
      ...row.options,
      returnTypeOverride: next.bodyResult,
    }),
  ).toBe(true);
  expect(() => completions.ordinaryCompletionMode(row.fn, row.signature.bodyResult, row.options)).toThrow();
});
