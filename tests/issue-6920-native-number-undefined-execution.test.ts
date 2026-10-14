// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
import * as sourceProducer from "../src/ir/program-source.js";
import * as directGc from "../src/codegen/index.js";
import * as directLinear from "../src/codegen-linear/index.js";

const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const indexInputs = [
  [2, 0],
  [NaN, 0],
  [-0, 0],
  [2, 1],
  [2, -1],
  [2, 0.5],
  [2, NaN],
  [2, Infinity],
  [2, 4294967296],
] as const;
const fixtures = [
  { name: "double indexed equality", body: "const a=[x];return a[i]===a[i]?1:0;", args: indexInputs },
  { name: "immutable alias self equality", body: "const a=[x];const v=a[i];return v===v?1:0;", args: indexInputs },
  {
    name: "immutable alias undefined equality",
    body: "const a=[x];const v=a[i];return v===undefined?1:0;",
    args: indexInputs,
  },
  { name: "alias chain", body: "const a=[x];const v=a[i];const w=v;return w===undefined?1:0;", args: indexInputs },
  { name: "strict inequality", body: "const a=[x];const v=a[i];return v!==undefined?1:0;", args: indexInputs },
  { name: "empty vector read", body: "const a:number[]=[];const v=a[i];return v===undefined?1:0;", args: indexInputs },
  {
    name: "conditional value join",
    body: "const a=[x];const v=i?a[99]:a[0];return v===undefined?1:0;",
    args: [
      [2, 0],
      [NaN, 0],
      [2, 1],
      [NaN, 1],
      [2, NaN],
      [NaN, NaN],
      [2, -0],
      [2, Infinity],
    ],
  },
  {
    name: "two selected undefined values",
    body: "const a=[x];const v=i?a[99]:a[0];const w=a[99];return v===w?1:0;",
    args: [
      [2, 0],
      [NaN, 0],
      [2, 1],
      [NaN, 1],
      [2, NaN],
      [NaN, NaN],
      [2, -0],
      [2, Infinity],
    ],
  },
  { name: "undefined versus actual number", body: "const a=[x];return a[i]===a[0]?1:0;", args: indexInputs },
  {
    name: "NaN and signed zero payloads",
    body: "const a=[x,0];return a[0]===a[1]?1:0;",
    args: [
      [NaN, 0],
      [-0, 0],
      [0, 0],
      [2, 0],
      [Infinity, 0],
    ],
  },
] as const;
afterEach(() => vi.restoreAllMocks());
it.each(fixtures)(
  "executes $name through source-free live and codec on all four profiles",
  async ({ name, body, args }) => {
    const text = "export function run(x:number,i:number):number{" + body + "}";
    const javascript = ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const jsExports: Record<string, (...values: readonly number[]) => number> = {};
    new Function("exports", javascript)(jsExports);
    const expected = args.map((values) => jsExports.run!(...values));
    if (name === "double indexed equality") expect(expected.slice(0, 4)).toEqual([1, 0, 1, 1]);
    const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
    const prepared = prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: policies[0],
      runtimePolicies: policies,
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
    const encoded = encodePreparedIrProgram(prepared.program);
    const poison = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
      throw Error("source reconstruction forbidden");
    });
    let executions = 0;
    for (const policy of policies) {
      await yieldTurn();
      const binaries: Uint8Array<ArrayBuffer>[] = [];
      for (const program of [prepared.program, decodePreparedIrProgram(encoded)]) {
        await yieldTurn();
        assertPreparedIrProgram(program);
        const accepted = acceptPreparedIrProgram(program, {
          ...policy,
          moduleName: "number-undefined",
          sourceMap: false,
          utf8Storage: false,
          sharedExceptionTag: false,
        });
        expect(accepted.kind).toBe("accepted");
        if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
        const binary = Uint8Array.from(emitBinary(emitAcceptedIrProgram(accepted).module));
        expect(WebAssembly.validate(binary)).toBe(true);
        const module = new WebAssembly.Module(binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = new WebAssembly.Instance(module, {});
        if (instance.exports._start) Reflect.apply(instance.exports._start as Function, undefined, []);
        for (let i = 0; i < args.length; i++) {
          const result = Reflect.apply(instance.exports.run as Function, undefined, args[i]!);
          expect(Object.is(result, expected[i])).toBe(true);
          executions++;
        }
        binaries.push(binary);
      }
      expect(binaries[0]).toEqual(binaries[1]);
    }
    expect(executions).toBe(args.length * 8);
    expect(poison).not.toHaveBeenCalled();
    poison.mockRestore();
    const noGc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw Error("legacy GC generator forbidden");
    });
    const noLinear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
      throw Error("legacy Linear generator forbidden");
    });
    let publicExecutions = 0;
    for (const policy of policies) {
      await yieldTurn();
      for (const optimize of [false, true]) {
        await yieldTurn();
        const compiled = await compile(text, { ...policy, optimize, sourceMap: false });
        expect(compiled.success, JSON.stringify(compiled.errors)).toBe(true);
        if (!compiled.success) throw Error(JSON.stringify(compiled.errors));
        const binary = Uint8Array.from(compiled.binary);
        expect(WebAssembly.validate(binary)).toBe(true);
        const module = new WebAssembly.Module(binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = new WebAssembly.Instance(module, {});
        if (instance.exports._start) Reflect.apply(instance.exports._start as Function, undefined, []);
        for (let i = 0; i < args.length; i++) {
          expect(Object.is(Reflect.apply(instance.exports.run as Function, undefined, args[i]!), expected[i])).toBe(
            true,
          );
          publicExecutions++;
        }
      }
    }
    expect(publicExecutions).toBe(args.length * 8);
    expect(noGc).not.toHaveBeenCalled();
    expect(noLinear).not.toHaveBeenCalled();
  },
  120000,
);
