// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { compile } from "../src/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import * as nativeProducer from "../src/ir/analysis/allocation-evidence/native-control-producer.js";
import * as sourceProducer from "../src/ir/program-source.js";
import { nativeVectorMutationIsProven } from "../src/ir/native-vector-mutation-proof.js";
import { ts } from "../src/ts-api.js";

const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const fixtures = [
  {
    name: "one iteration",
    source: "export function run(n:number):number{const a=[2];for(let i=0;i<a.length;i++){a[i]+=n;}return a[0];}",
    calls: [
      [3, 5],
      [-2, 0],
    ],
  },
  {
    name: "nested scalar loop",
    source:
      "export function run(n:number):number{const a=[2,5];for(let i=0;i<a.length;i++){for(let j=0;j<2;j++){a[i]+=n;}}return a[0]+a[1];}",
    calls: [
      [3, 19],
      [-2, -1],
    ],
  },

  {
    name: "plain",
    source:
      "export function run(n:number):number{const a=[2,5];for(let i=0;i<a.length;i++){a[i]=n+i;}return a[0]+a[1];}",
    calls: [
      [3, 7],
      [-2, -3],
    ],
  },
  {
    name: "compound",
    source:
      "export function run(n:number):number{const a=[2,5];for(let i=0;i<a.length;i++){a[i]+=n;}return a[0]+a[1];}",
    calls: [
      [3, 13],
      [-2, 3],
    ],
  },
  {
    name: "postfix",
    source: "export function run(n:number):number{const a=[2,5];for(let i=0;i<a.length;i++){a[i]++;}return a[0]+a[1];}",
    calls: [
      [3, 9],
      [-2, 9],
    ],
  },
  {
    name: "parameter",
    source:
      "function change(a:number[],n:number):number{for(let i=0;i<a.length;i++){a[i]=n+i;}return a[0]+a[1];}export function run(n:number):number{return change([2,5],n);}",
    calls: [
      [3, 7],
      [-2, -3],
    ],
  },
  {
    name: "alias observation",
    source:
      "function change(a:number[],n:number):number{for(let i=0;i<a.length;i++){a[i]+=n;}return 0;}export function run(n:number):number{const a=[2,5];const b=a;change(a,n);return b[0]+b[1];}",
    calls: [
      [3, 13],
      [-2, 3],
    ],
  },
  {
    name: "branch writes",
    source:
      "export function run(n:number):number{const a=[2,5];for(let i=0;i<a.length;i++){if(i===0)a[i]=n;else a[i]+=n;}return a[0]+a[1];}",
    calls: [
      [3, 11],
      [-2, 1],
    ],
  },
  {
    name: "sequential scalar effects",
    source:
      "export function run(n:number):number{const a=[2,5];let k=n;for(let i=0;i<a.length;i++){k=k+1;a[i]+=k;}return a[0]+a[1]+k;}",
    calls: [
      [3, 21],
      [-2, 6],
    ],
  },
  {
    name: "empty",
    source:
      "export function run(n:number):number{const a:number[]=[];for(let i=0;i<a.length;i++){a[i]=n;}return a.length;}",
    calls: [
      [3, 0],
      [-2, 0],
    ],
  },
];
const refusals = [
  "export function run(n:number):number{const a=[2,5];for(let i=0;i<a.length;i++){{const i=5;const unused=i;}a[i]=n+i;}return a[0]+a[1];}",
  "export function run():number{const a=[2,5];const box={get value():number{a.length=0;return 9;}};for(let i=0;i<a.length;i++){a[i]=box.value;}return a[0];}",
  "export function run():number{const a=[2,5];let k=0;for(let i=0;i<a.length;i++){a[i]+=(k=k+1);}return a[0];}",
  "function change(a:number[]):number{for(let i=0;i<a.length;i++){var a:number[]=[0];a[i]=9;}return a[0];}export function run():number{return change([2,5]);}",
  "function change(a:number[]):number{a[0]=9;return a[0];}export function run():number{return change([]);}",
  "export function run():number{const a=[2,5];a[1.5]=9;return a[0];}",
  "export function run():number{const a=[2,5];a[NaN]=9;return a[0];}",
  "export function run():number{const a=[2,5];a[Infinity]=9;return a[0];}",
  "export function run():number{const a=[2,5];a[-1]=9;return a[0];}",
  "export function run():number{const a=[2,5];a[a.length]=9;return a[0];}",
  "export function run():number{const a=[2,5];const b=[7];for(let i=0;i<a.length;i++){b[i]=9;}return b[0];}",
  "export function run():number{const a=[2,5];for(let i=0;i<a.length;i++){const a=[7];a[i]=9;}return a[0];}",
  "export function run():number{const a=[2,5];for(let i=0;i<a.length;i++){const i=-1;a[i]=9;}return a[0];}",
  "export function run():number{const a=[2,5];const alias=a;for(let i=0;i<a.length;i++){alias.length=0;a[i]=9;}return a[0];}",
  "function value():number{return 9;}export function run():number{const a=[2,5];for(let i=0;i<a.length;i++){a[i]=value();}return a[0];}",
  "export function run():number{const a=[2,5];for(let i=0;i<a.length;i++){i++;a[i]=9;}return a[0];}",
  "export function run():number{const a=[2,5];for(let i=0;i<a.length;i+=2147483647){a[i]=9;}return a[0];}",
];
afterEach(() => vi.restoreAllMocks());
describe("native symbol-bound fixed vector mutation", () => {
  it("keeps the synchronous proof out of an otherwise identical async owner", () => {
    for (const [asynchronous, coercion] of [
      [false, false],
      [true, false],
      [false, true],
    ]) {
      const text = `export ${asynchronous ? "async " : ""}function run(n:number):${asynchronous ? "Promise<number>" : "number"}{const a=[2,5];${coercion ? "const box={valueOf(){a.length=0;return 9;}};" : ""}for(let i=0;i<a.length;i++){a[i]=${coercion ? "+box" : "n"};}return 0;}`;
      const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
      let access: ts.ElementAccessExpression | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isElementAccessExpression(node)) access = node;
        ts.forEachChild(node, visit);
      };
      visit(ast.entryFile);
      expect(access).toBeDefined();
      expect(
        nativeVectorMutationIsProven(access!, ast.checker, (expression) =>
          ast.checker.isArrayType(ast.checker.getTypeAtLocation(expression)),
        ),
      ).toBe(!asynchronous && !coercion);
    }
  });
  it.each(fixtures)("$name: same prepared program on four profiles, live and codec", async (fixture) => {
    const ast = analyzeMultiSource({ "./entry.ts": fixture.source }, "./entry.ts");
    const result = prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: policies[0],
      runtimePolicies: policies,
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    expect(result.kind, JSON.stringify(result)).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    const program = result.program,
      sealed = encodePreparedIrProgram(program);
    const native = vi.spyOn(nativeProducer, "analyzeNativeVectorControl").mockImplementation(() => {
      throw new Error("producer replay forbidden");
    });
    const source = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
      throw new Error("source replay forbidden");
    });
    const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
      throw new Error("direct Linear forbidden");
    });
    const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw new Error("direct GC forbidden");
    });
    const decoded = decodePreparedIrProgram(sealed);
    expect(encodePreparedIrProgram(decoded)).toBe(sealed);
    let executions = 0;
    for (const policy of policies) {
      const binaries: Uint8Array[] = [];
      for (const current of [program, decoded]) {
        const accepted = acceptPreparedIrProgram(current, {
          ...policy,
          moduleName: "mutation",
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
        for (const [input, expected] of fixture.calls) {
          expect((instance.exports.run as (n: number) => number)(input!)).toBe(expected);
          executions++;
        }
      }
      expect(binaries[0]).toEqual(binaries[1]);
    }
    expect(executions).toBe(16);
    expect(native).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(linear).not.toHaveBeenCalled();
    expect(gc).not.toHaveBeenCalled();
    expect(encodePreparedIrProgram(program)).toBe(sealed);
  });
  it("executes the genuine public compiler", async () => {
    for (const fixture of fixtures)
      for (const policy of policies) {
        const result = await compile(fixture.source, { ...policy, optimize: false, sourceMap: false });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const module = await WebAssembly.compile(Uint8Array.from(result.binary!));
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        if (typeof instance.exports._start === "function") instance.exports._start();
        for (const [input, expected] of fixture.calls)
          expect((instance.exports.run as (n: number) => number)(input!)).toBe(expected);
      }
  });
  it("refuses absent, invalidated, shadowed and non-integer store proofs", async () => {
    for (const source of refusals)
      for (const policy of policies) {
        const result = await compile(source, { ...policy, optimize: false, sourceMap: false });
        expect(result.success, source).toBe(false);
        expect(result.binary?.length ?? 0).toBe(0);
        expect(result.errors.some((error) => error.severity === "error" && typeof error.line === "number")).toBe(true);
      }
  });
});
