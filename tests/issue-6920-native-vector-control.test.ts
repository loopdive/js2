// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
import { verifyNativeAllocationEvidence as verifyAllocationEvidence } from "../src/ir/analysis/allocation-evidence/structured-vector-profile.js";
import { collectLinearVectorFlow } from "../src/ir/program/linear-vector-flow.js";
import { forEachInstrDeep, type IrInstr, type IrModule } from "../src/ir/core/nodes.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import * as nativeProducer from "../src/ir/analysis/allocation-evidence/native-control-producer.js";
import * as sourceProducer from "../src/ir/program-source.js";

const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const fixtures = [
  {
    name: "local counted",
    source:
      "export function run(n:number):number{const a=[2,5];let sum=0;for(let i=0;i<n;i++){sum=sum+a[i];}return sum;}",
    calls: [
      [0, 0],
      [1, 2],
      [2, 7],
    ],
    payload: [2, 5],
  },
  {
    name: "internal counted",
    source:
      "function sum(a:number[],n:number):number{let total=0;for(let i=0;i<n;i++){total=total+a[i];}return total;}export function run(n:number):number{return sum([2,5],n);}",
    calls: [
      [0, 0],
      [1, 2],
      [2, 7],
    ],
    payload: [2, 5],
  },
  {
    name: "while",
    source:
      "export function run(n:number):number{const a=[2,5];let i=0;let total=0;while(i<n){total=total+a[i];i++;}return total;}",
    calls: [
      [0, 0],
      [1, 2],
      [2, 7],
    ],
    payload: [2, 5],
  },
  {
    name: "post condition",
    source:
      "export function run(n:number):number{const a=[2,5];let i=0;let total=0;do{total=total+a[i];i++;}while(i<n);return total;}",
    calls: [
      [0, 2],
      [1, 2],
      [2, 7],
    ],
    payload: [2, 5],
  },
  {
    name: "conditional literal",
    source:
      "function choose(c:boolean):number[]{return c?[2,5]:[3,7];}export function run(c:boolean):number{const a=choose(c);return a[0]+a[1];}",
    calls: [
      [0, 10],
      [1, 7],
    ],
    payload: null,
  },
  {
    name: "conditional aliases",
    source:
      "function choose(c:boolean):number[]{const a=[2,5];const b=[3,7];return c?a:b;}export function run(c:boolean):number{const a=choose(c);return a[0]+a[1];}",
    calls: [
      [0, 10],
      [1, 7],
    ],
    payload: null,
  },
  {
    name: "conditional formal",
    source:
      "function choose(a:number[],c:boolean):number[]{return c?a:[3,7];}export function run(c:boolean):number{const a=choose([2,5],c);return a[0]+a[1];}",
    calls: [
      [0, 10],
      [1, 7],
    ],
    payload: null,
  },
  {
    name: "ordinary branch returns",
    source:
      "function choose(c:boolean):number[]{if(c)return [2,5];return [3,7];}export function run(c:boolean):number{const a=choose(c);return a[0]+a[1];}",
    calls: [
      [0, 10],
      [1, 7],
    ],
    payload: null,
  },
  {
    name: "nested plain early return",
    source:
      "function choose(a:number[],c:boolean):number[]{for(let i=0;i<2;i++){if(c)return a;}return [3,7];}export function run(c:boolean):number{const a=choose([2,5],c);return a[0]+a[1];}",
    calls: [
      [0, 10],
      [1, 7],
    ],
    payload: null,
  },
  {
    name: "nested fresh early return",
    source:
      "function choose(c:boolean):number[]{for(let i=0;i<2;i++){if(c)return [2,5];}return [3,7];}export function run(c:boolean):number{const a=choose(c);return a[0]+a[1];}",
    calls: [
      [0, 10],
      [1, 7],
    ],
    payload: null,
  },
  {
    name: "swapped formal results",
    source:
      "function choose(a:number[],b:number[],flag:boolean):number[]{if(flag)return a;return b;}function read(v:number[]):number{return v[1];}export function run(flag:boolean):number{const a=[11,12];const b=[21,22];return read(choose(b,a,flag));}",
    calls: [
      [0, 12],
      [1, 22],
    ],
    payload: null,
  },
  {
    name: "nested conditional roots",
    source:
      "function choose(a:number[],c:boolean,d:boolean):number[]{return c?(d?a:[3,7]):[11,13];}export function run(n:number):number{const a=choose([2,5],n>0,n>1);return a[0]+a[1];}",
    calls: [
      [0, 24],
      [1, 10],
      [2, 7],
    ],
    payload: null,
  },
  {
    name: "conditional call root",
    source:
      "function make(n:number):number[]{return [n,n+1];}function choose(c:boolean):number[]{return c?make(2):[3,7];}export function run(c:boolean):number{const a=choose(c);return a[0]+a[1];}",
    calls: [
      [0, 10],
      [1, 5],
    ],
    payload: null,
  },
  {
    name: "returned vector survives later allocation",
    source:
      "function choose(c:boolean):number[]{return c?[2,5]:[3,7];}export function run(c:boolean):number{const a=choose(c);const b=choose(!c);return a[0]+a[1]+b[0];}",
    calls: [
      [0, 12],
      [1, 10],
    ],
    payload: null,
  },
];
function prepare(source: string) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
}
function required(source: string) {
  const result = prepare(source);
  expect(result.kind, JSON.stringify(result)).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  return result.program;
}
function instructions(module: IrModule): IrInstr[] {
  const result: IrInstr[] = [];
  for (const fn of module.functions)
    for (const block of fn.blocks)
      for (const root of block.instrs) forEachInstrDeep(root, (instr) => result.push(instr));
  return result;
}
afterEach(() => vi.restoreAllMocks());
describe("native vectors through actual structured control flow", () => {
  it.each(fixtures)("$name: one checked program, four profiles, live and codec", async (fixture) => {
    const program = required(fixture.source),
      sealed = encodePreparedIrProgram(program);
    expect(verifyAllocationEvidence(program.ir, program.allocations)).toMatchObject({
      kind: "verified",
      profile: "structured-numeric-vector-control-v1",
    });
    const native = vi.spyOn(nativeProducer, "analyzeNativeVectorControl").mockImplementation(() => {
      throw new Error("native producer replay forbidden");
    });
    const decoded = decodePreparedIrProgram(sealed);
    expect(encodePreparedIrProgram(decoded)).toBe(sealed);
    const source = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
      throw new Error("source reread forbidden");
    });
    const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
      throw new Error("direct Linear forbidden");
    });
    const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw new Error("direct GC forbidden");
    });
    let executions = 0;
    for (const policy of policies) {
      const binaries: Uint8Array[] = [];
      for (const current of [program, decoded]) {
        const accepted = acceptPreparedIrProgram(current, {
          ...policy,
          moduleName: "control",
          sourceMap: false,
          utf8Storage: false,
          sharedExceptionTag: false,
        });
        expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
        if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
        const binary = new Uint8Array(emitBinary(emitAcceptedIrProgram(accepted).module));
        binaries.push(binary);
        expect(WebAssembly.validate(binary)).toBe(true);
        const module = await WebAssembly.compile(binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        if (typeof instance.exports._start === "function") instance.exports._start();
        for (const [arg, expected] of fixture.calls) {
          expect((instance.exports.run as (n: number) => number)(arg!)).toBe(expected);
          executions++;
        }
        if (policy.backend === "linear" && fixture.name === "conditional literal") {
          const memory = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
          expect(memory.getFloat64(1040, true)).toBe(3);
          expect(memory.getFloat64(1048, true)).toBe(7);
          const next = 1024 + 16 + 8 * memory.getUint32(1036, true);
          expect(memory.getFloat64(next + 16, true)).toBe(2);
          expect(memory.getFloat64(next + 24, true)).toBe(5);
          const end = next + 16 + 8 * memory.getUint32(next + 12, true);
          expect(memory.getUint32(end + 8, true)).toBe(0);
        }
      }
      expect(binaries[1]).toEqual(binaries[0]);
    }
    expect(executions).toBe(8 * fixture.calls.length);
    expect(native).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(linear).not.toHaveBeenCalled();
    expect(gc).not.toHaveBeenCalled();
    expect(encodePreparedIrProgram(program)).toBe(sealed);
  });
  it("executes public native compilation across the four profiles", async () => {
    for (const fixture of fixtures)
      for (const policy of policies) {
        const result = await compile(fixture.source, { ...policy, optimize: false, sourceMap: false });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const binary = Uint8Array.from(result.binary!);
        expect(WebAssembly.validate(binary)).toBe(true);
        const module = await WebAssembly.compile(binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        if (typeof instance.exports._start === "function") instance.exports._start();
        for (const [arg, expected] of fixture.calls)
          expect((instance.exports.run as (n: number) => number)(arg!)).toBe(expected);
      }
  });
  it("rejects undeclared, wrong-type and uninitialized slots independently", () => {
    const program = required(fixtures[0]!.source);
    for (const mutant of ["undeclared", "type", "uninitialized"] as const) {
      const module = structuredClone(program.ir),
        all = instructions(module);
      if (mutant === "undeclared") Object.assign(all.find((i) => i.kind === "slot.read")!, { slotIndex: 999 });
      if (mutant === "type")
        Object.assign(all.find((i) => i.kind === "slot.read")!, { resultType: { kind: "val", val: { kind: "f64" } } });
      if (mutant === "uninitialized") {
        const block = module.functions[0]!.blocks[0]!;
        Object.assign(block, { instrs: block.instrs.filter((i) => i.kind !== "slot.write") });
      }
      expect(verifyAllocationEvidence(module, program.allocations)).toMatchObject({
        kind: "invalid",
        code: "lexical-definition",
      });
    }
  });
  it("rejects missing arms, duplicate SSA, sibling scope leaks and stale return facts", () => {
    const program = required(fixtures[4]!.source);
    for (const mutant of ["missing", "duplicate", "sibling", "facts"] as const) {
      const module = structuredClone(program.ir),
        join = instructions(module).find((i) => i.kind === "if" && i.resultType?.kind === "vec")!;
      if (join.kind !== "if") throw new Error("missing genuine vector conditional");
      if (mutant === "missing") Object.assign(join, { else: [] });
      if (mutant === "duplicate") Object.assign(join.else[0]!, { result: join.then[0]!.result });
      if (mutant === "sibling") Object.assign(join, { elseValue: join.thenValue });
      if (mutant === "facts") Object.assign(module.functions[0]!.blocks[0]!, { terminator: { kind: "unreachable" } });
      expect(verifyAllocationEvidence(module, program.allocations).kind).toBe("invalid");
    }
  });
  it("replays plain early-return allocation escape and rejects omitted payload effects", () => {
    const program = required(fixtures[9]!.source);
    const early = instructions(program.ir).find((instr) => instr.kind === "early.return")!;
    expect(early.kind).toBe("early.return");
    const allocations = program.linearAllocationFacts!.facts.allocations;
    expect(allocations.filter((site) => site.escape === "returned")).toHaveLength(2);
    const module = structuredClone(program.ir);
    const branch = instructions(module).find((instr) => instr.kind === "if.stmt")!;
    if (branch.kind !== "if.stmt") throw new Error("positive control lacks genuine return arm");
    Object.assign(branch, { then: branch.then.filter((instr) => instr.kind !== "early.return") });
    expect(verifyAllocationEvidence(module, program.allocations)).toMatchObject({
      kind: "invalid",
      code: "namespace-value",
    });
  });
  it("refuses initialization borrowed from a loop or one branch and leaking condition SSA", () => {
    const program = required(fixtures[0]!.source);
    for (const mutant of ["loop", "arm", "condition"] as const) {
      const module = structuredClone(program.ir),
        block = module.functions[0]!.blocks[0]!;
      const loop = block.instrs.find((instr) => instr.kind === "for.loop")!;
      if (loop.kind !== "for.loop") throw new Error("positive control lacks real loop");
      const initialization = block.instrs.find((instr) => instr.kind === "slot.write" && instr.slotIndex === 0)!;
      if (mutant === "condition") {
        const after = block.instrs.at(-1)!;
        Object.assign(after, { kind: "binary", op: "f64.add", lhs: loop.condValue, rhs: loop.condValue });
      } else {
        Object.assign(block, { instrs: block.instrs.filter((instr) => instr !== initialization) });
        if (mutant === "loop") Object.assign(loop, { body: [initialization, ...loop.body] });
        else {
          const indexSeed = block.instrs.find((instr) => instr.kind === "slot.write" && instr.slotIndex === 1)!;
          if (indexSeed.kind !== "slot.write") throw new Error("positive control lacks real i32 seed");
          const branch = {
            kind: "if.stmt",
            cond: indexSeed.value,
            then: [initialization],
            else: [],
            result: null,
            resultType: null,
          };
          const position = block.instrs.indexOf(loop);
          Object.assign(block, {
            instrs: [...block.instrs.slice(0, position), branch, ...block.instrs.slice(position)],
          });
        }
      }
      expect(verifyAllocationEvidence(module, program.allocations)).toMatchObject({
        kind: "invalid",
        code: "lexical-definition",
      });
    }
  });
  it("keeps both branch sites and refuses a hidden caller with a different backing extent", () => {
    const program = required(fixtures[4]!.source),
      origins = collectLinearVectorFlow(program.ir);
    const run = program.ir.functions.find((fn) => fn.name === "run")!,
      receiver = instructions({ functions: [run] } as IrModule).find((i) => i.kind === "vec.len")!;
    if (receiver.kind !== "vec.len") throw new Error("no actual vector demand");
    expect(origins.get(run.unitId)!.get(receiver.vec)).toHaveLength(2);
    const different = required(
      "function choose(a:number[],c:boolean):number[]{return c?a:[3,7];}export function run():number{const a=choose([2,5],true);const b=choose([1,2,3],false);return a[0]+b[0];}",
    );
    expect(() => collectLinearVectorFlow(different.ir)).toThrow(/mixed requested/);
  });
});
