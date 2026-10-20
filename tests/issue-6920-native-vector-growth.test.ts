// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import { compile } from "../src/index.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import { IrInvariantError } from "../src/shared/contracts/ir-preparation-errors.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { PreparedIrProgramInvariantError } from "../src/shared/contracts/prepared-ir-invariant-error.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { irVecElemSetSymbol } from "../src/ir/core/vector-runtime.js";
import { forEachInstrDeep, type IrInstr, type IrValueId } from "../src/ir/core/nodes.js";
import * as growth from "../src/ir/program/native-vector-growth-source.js";
const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const sources = [
  "export function run():number{const a=[2,5];return a.push(11)+a.length+a[2];}",
  "const a=[2,5];export function run():number{return a.push(11)+a.length+a[2];}",
];
function prepare(source: string, policy: (typeof policies)[number]) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    runtimePolicies: policies,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
}
afterEach(() => vi.restoreAllMocks());
describe("native f64 growth source capability boundary", () => {
  it.each(policies)(
    "prepares genuine local/global push with checked append resources for $backend/$target",
    (policy) => {
      for (const source of sources) {
        const result = prepare(source, policy);
        expect(result.kind, JSON.stringify(result)).toBe("prepared");
        if (result.kind !== "prepared") throw Error(JSON.stringify(result));
        expect(result.program.runtime).toHaveLength(4);
      }
    },
  );
  it("executes eight genuine public local/global append cases", async () => {
    const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
      throw Error("direct Linear forbidden");
    });
    const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw Error("direct GC forbidden");
    });
    let executions = 0;
    for (const source of sources)
      for (const policy of policies) {
        const result = await compile(source, { ...policy, optimize: false, sourceMap: false });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        expect(result.binary!.length).toBeGreaterThan(0);
        const module = new WebAssembly.Module(Uint8Array.from(result.binary!));
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = new WebAssembly.Instance(module, {});
        if (instance.exports._start) (instance.exports._start as () => void)();
        expect((instance.exports.run as () => number)()).toBe(17);
        executions++;
      }
    expect(executions).toBe(8);
    expect(linear).not.toHaveBeenCalled();
    expect(gc).not.toHaveBeenCalled();
  });
  it("executes a genuine unit with the same display name without borrowing intrinsic identity", async () => {
    const source =
      "function __ir_vec_elem_set_f64(a:number[],i:number,n:number):number{return a[0]+n;}export function run():number{const a=[2,5];return __ir_vec_elem_set_f64(a,0,7);}";
    for (const policy of policies) {
      const result = await compile(source, { ...policy, optimize: false, sourceMap: false });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const module = await WebAssembly.compile(Uint8Array.from(result.binary!));
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = await WebAssembly.instantiate(module, {});
      if (instance.exports._start) (instance.exports._start as () => void)();
      expect((instance.exports.run as () => number)()).toBe(9);
    }
  });
  it("fails closed on missing or contradictory receiver evidence in generated source IR", () => {
    const ast = analyzeMultiSource({ "./entry.ts": sources[0]! }, "./entry.ts");
    const bypass = vi.spyOn(growth, "refuseUnbackedNativeNumericGrowth").mockImplementation(() => {});
    const source = prepareIrProgramSources({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: policies[0],
      runtimePolicies: policies,
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    bypass.mockRestore();
    expect(source.kind).toBe("prepared");
    if (source.kind !== "prepared") throw Error(JSON.stringify(source));
    for (const change of ["missing-argument", "undefined-ssa", "wrong-type", "layoutful"] as const) {
      const fn = structuredClone(source.ir.functions.find((fn) => fn.name === "run")!);
      const all: IrInstr[] = [];
      for (const block of fn.blocks) for (const root of block.instrs) forEachInstrDeep(root, (i) => all.push(i));
      const call = all.find(
        (i): i is Extract<IrInstr, { kind: "call" }> =>
          i.kind === "call" &&
          i.target.binding.kind === "intrinsic" &&
          i.target.binding.symbol === irVecElemSetSymbol({ kind: "val", val: { kind: "f64" } }),
      )!;
      const vector = all.find((i): i is Extract<IrInstr, { kind: "vec.new_fixed" }> => i.kind === "vec.new_fixed")!;
      expect(call).toBeDefined();
      expect(vector).toBeDefined();
      if (change === "missing-argument") (call as { args: readonly IrValueId[] }).args = [];
      else if (change === "undefined-ssa")
        (call as { args: readonly IrValueId[] }).args = [999999 as IrValueId, ...call.args.slice(1)];
      else
        (vector as { resultType: unknown }).resultType =
          change === "wrong-type"
            ? { kind: "vec", elementType: { kind: "val", val: { kind: "externref" } }, nullable: false }
            : { ...vector.resultType, layout: {} };
      expect(() => growth.refuseUnbackedNativeNumericGrowth(fn)).toThrow(IrInvariantError);
    }
  });
  it("rejects restored DATA lacking the newly declared runtime callable inventory", () => {
    const result = prepare("export function run():number{const a=[2,5];return a[0]+a[1];}", policies[0]);
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw Error(JSON.stringify(result));
    const forbidden = vi.spyOn(growth, "refuseUnbackedNativeNumericGrowth").mockImplementation(() => {
      throw Error("source capability replay forbidden");
    });
    const decoded = decodePreparedIrProgram(encodePreparedIrProgram(result.program));
    const module = structuredClone(decoded.ir);
    const fn = module.functions.find((f) => f.name === "run")!;
    const body = fn.blocks[0]!.instrs as IrInstr[];
    const all: IrInstr[] = [];
    body.forEach((root) => forEachInstrDeep(root, (i) => all.push(i)));
    const vector = all.find((i): i is Extract<IrInstr, { kind: "vec.new_fixed" }> => i.kind === "vec.new_fixed")!;
    const get = all.find((i): i is Extract<IrInstr, { kind: "vec.get" }> => i.kind === "vec.get")!;
    body.push({
      kind: "call",
      result: null,
      resultType: null,
      target: irIntrinsicFuncRef(irVecElemSetSymbol({ kind: "val", val: { kind: "f64" } })),
      args: [vector.result!, get.index, vector.elements[0]!],
    });
    let failure: unknown;
    try {
      assertPreparedIrProgram({ ...decoded, ir: module });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PreparedIrProgramInvariantError);
    if (!(failure instanceof PreparedIrProgramInvariantError)) throw Error("missing DATA invariant failure");
    expect(failure.code).toBe("invalid-prepared-data");
    expect(failure.message).toContain("runtime ABI declaration population");
    expect(forbidden).not.toHaveBeenCalled();
  });
});
