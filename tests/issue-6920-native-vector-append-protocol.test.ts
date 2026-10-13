// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import * as growth from "../src/ir/program/native-vector-growth-source.js";
import {
  collectNativeNumericAppendProtocol,
  isNativeNumericAppendCall,
} from "../src/ir/analysis/allocation-evidence/numeric-append-protocol.js";
import { IrUnsupportedError, IrInvariantError } from "../src/shared/contracts/ir-preparation-errors.js";
import { collectVectorCallableDemands } from "../src/ir/runtime/vector-callables.js";
import { irRuntimeCallableDeclaration } from "../src/ir/runtime/callable-declarations.js";
import {
  NUMERIC_APPEND_DECLARATION,
  NUMERIC_APPEND_RUNTIME_PROVIDERS,
  numericAppendProviderMismatch,
} from "../src/ir/runtime/numeric-vector-callables.js";
import { forEachInstrDeep, type IrInstr, type IrValueId } from "../src/ir/core/nodes.js";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const cases = [
  { name: "local", calls: 1, source: "export function run():number{const a=[2,5];return a.push(11)+a.length+a[2];}" },
  { name: "global", calls: 1, source: "const a=[2,5];export function run():number{return a.push(11)+a.length+a[2];}" },
  { name: "empty", calls: 1, source: "export function run():number{const a:number[]=[];return a.push(11)+a.length;}" },
  {
    name: "callee",
    calls: 2,
    source:
      "function add(a:number[]):number{return a.push(11);}export function run():number{const a=[2,5];return add(a)+a.push(13)+a.length;}",
  },
  {
    name: "RHS append before length",
    calls: 2,
    source:
      "function inner(a:number[]):number{return a.push(7);}export function run():number{const a=[2,5];return a.push(inner(a))+a.length;}",
  },
  {
    name: "while",
    calls: 1,
    source: "export function run():number{const a=[2,5];let i=0;while(i<4){a.push(i);i++;}return a.length;}",
  },
];
function raw(source: string) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const bypass = vi.spyOn(growth, "refuseUnbackedNativeNumericGrowth").mockImplementation(() => {});
  const result = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  bypass.mockRestore();
  expect(result.kind).toBe("prepared");
  if (result.kind !== "prepared") throw Error(JSON.stringify(result));
  return result.ir;
}
afterEach(() => vi.restoreAllMocks());
for (const fixture of cases)
  it(`authenticates genuine raw source IR ${fixture.name} without source/producer replay`, () => {
    const module = raw(fixture.source),
      before = JSON.stringify(module);
    const calls = collectNativeNumericAppendProtocol(module.functions);
    expect(calls).toHaveLength(fixture.calls);
    expect(calls.every((row) => row.call.args[0] === row.receiver && module.functions.includes(row.fn))).toBe(true);
    expect(JSON.stringify(module)).toBe(before);
    expect(collectNativeNumericAppendProtocol(module.functions)).toEqual(calls);
  });
it("distinguishes unsupported indexed growth/length writers from contradictory receiver signatures", () => {
  const actual = raw(cases[0]!.source);
  for (const change of ["constant-index", "length-writer", "extra-arg", "foreign-ssa", "wrong-receiver"] as const) {
    const module = structuredClone(actual),
      fn = module.functions.find((f) => f.name === "run")!;
    const all: IrInstr[] = [];
    for (const block of fn.blocks) for (const root of block.instrs) forEachInstrDeep(root, (i) => all.push(i));
    const call = all.find(isNativeNumericAppendCall)!;
    const vector = all.find((i): i is Extract<IrInstr, { kind: "vec.new_fixed" }> => i.kind === "vec.new_fixed")!;
    expect(call).toBeDefined();
    expect(vector).toBeDefined();
    if (change === "constant-index") {
      const index = all.find((i) => i.result === call.args[1])!;
      const body = fn.blocks[0]!.instrs as IrInstr[];
      const position = body.indexOf(index);
      expect(position).toBeGreaterThanOrEqual(0);
      body[position] = {
        kind: "const",
        result: index.result,
        resultType: index.resultType,
        value: { kind: "i32", value: 0 },
      };
    } else if (change === "length-writer")
      (fn.blocks[0]!.instrs as IrInstr[]).push({
        kind: "vec.set_length",
        result: null,
        resultType: null,
        vec: call.args[0]!,
        length: call.args[1]!,
      });
    else if (change === "extra-arg") (call as { args: readonly IrValueId[] }).args = [...call.args, call.args[2]!];
    else if (change === "foreign-ssa")
      (call as { args: readonly IrValueId[] }).args = [999999 as IrValueId, ...call.args.slice(1)];
    else
      (vector as { resultType: unknown }).resultType = {
        kind: "vec",
        nullable: false,
        elementType: { kind: "val", val: { kind: "externref" } },
      };
    expect(() => collectNativeNumericAppendProtocol(module.functions)).toThrow(
      change === "constant-index" || change === "length-writer" ? IrUnsupportedError : IrInvariantError,
    );
  }
});
it("refuses a genuine RHS unit effect moved after its captured length", () => {
  const module = structuredClone(raw(cases[4]!.source)),
    fn = module.functions.find((f) => f.name === "run")!;
  const body = fn.blocks[0]!.instrs as IrInstr[];
  const effect = body.find((i) => i.kind === "call" && i.target.binding.kind === "unit")!;
  expect(effect).toBeDefined();
  body.splice(body.indexOf(effect), 1);
  const length = body.findIndex((i) => i.kind === "vec.len");
  expect(length).toBeGreaterThanOrEqual(0);
  body.splice(length + 1, 0, effect);
  expect(() => collectNativeNumericAppendProtocol(module.functions)).toThrow(
    /argument must evaluate before its length capture/,
  );
});
it("does not borrow intrinsic authority from a genuine unit display name", () => {
  const module = raw(
    "function __ir_vec_elem_set_f64(a:number[],i:number,n:number):number{return a[0]+n;}export function run():number{const a=[2,5];return __ir_vec_elem_set_f64(a,0,7);}",
  );
  expect(collectNativeNumericAppendProtocol(module.functions)).toEqual([]);
});

it("declares actual three-argument calls and preserves complete owner demand census", () => {
  const module = raw(cases[4]!.source);
  const calls = collectNativeNumericAppendProtocol(module.functions);
  expect(calls).toHaveLength(2);
  for (const row of calls) expect(irRuntimeCallableDeclaration(row.call.target)).toBe(NUMERIC_APPEND_DECLARATION);
  expect(NUMERIC_APPEND_DECLARATION.params[0]).toMatchObject({ kind: "vec", nullable: true });
  expect(NUMERIC_APPEND_DECLARATION.params).toHaveLength(3);
  expect(NUMERIC_APPEND_DECLARATION.results).toEqual([]);
  const demands = collectVectorCallableDemands(module.functions);
  expect(demands).toHaveLength(module.functions.length);
  expect(demands.flatMap((owner) => owner.uses)).toHaveLength(2);
  expect(
    demands.flatMap((owner) => owner.uses).every((use) => use.feature === NUMERIC_APPEND_DECLARATION.feature),
  ).toBe(true);
  const canonical = NUMERIC_APPEND_RUNTIME_PROVIDERS[0]!;
  expect(numericAppendProviderMismatch(canonical)).toBeUndefined();
  expect(numericAppendProviderMismatch({ ...canonical, supportedBackends: ["wasmgc"] })).toMatch(/supportedBackends/);
});
