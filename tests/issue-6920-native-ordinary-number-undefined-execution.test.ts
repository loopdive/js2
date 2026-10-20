// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { ts } from "../src/ts-api.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertPreparedIrProgram } from "../src/ir/program/validation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { emitBinary } from "../src/emit/binary.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import * as source from "../src/ir/program-source.js";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;
const fixtures = [
  {
    name: "Number helper",
    text: "function effect(x:number):void{return x as never;}export function run(x:number):number{return effect(x)===undefined?1:0;}",
    args: [0, 4, NaN, -0, Infinity],
  },
  {
    name: "Number or Undefined helper",
    text: "function effect(x:number):void{if(x)return 4 as never;return;}export function run(x:number):number{return effect(x)===undefined?1:0;}",
    args: [0, 1, NaN, -0, Infinity],
  },
  {
    name: "NaN payload through repeated calls",
    text: "function effect(x:number):void{return x as never;}export function run(x:number):number{const a=effect(x);const b=effect(x);return a===b?1:0;}",
    args: [0, 4, NaN, -0, Infinity],
  },
  {
    name: "literal Number4 payload comparison",
    text: "function effect():void{return 4 as never;}export function run(x:number):number{return effect()===4?x:0;}",
    args: [4, NaN, -0, Infinity, -Infinity],
  },
] as const;
afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});
// Productive assertions for the separately received physical signature joins.
it.each(fixtures)("executes $name through actual internal call/live/codec on four profiles", async (fixture) => {
  const ast = analyzeMultiSource({ "./entry.ts": fixture.text }, "./entry.ts");
  const outcome = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    deferTopLevelInit: false,
  });
  expect(outcome.kind).toBe("prepared");
  if (outcome.kind !== "prepared") throw Error(JSON.stringify(outcome));
  const exports: { run?: (n: number) => number } = {};
  new Function(
    "exports",
    ts.transpileModule(fixture.text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  )(exports);
  const expected = fixture.args.map((n) => exports.run!(n)),
    encoded = encodePreparedIrProgram(outcome.program);
  const reconstruction = vi.spyOn(source, "prepareIrProgramSources").mockImplementation(() => {
    throw Error("source reconstruction forbidden");
  });
  const oldGc = vi.spyOn(gc, "generateModule").mockImplementation(() => {
    throw Error("legacy GC forbidden");
  });
  const oldLinear = vi.spyOn(linear, "generateLinearModule").mockImplementation(() => {
    throw Error("legacy Linear forbidden");
  });
  let executions = 0,
    acceptedCount = 0,
    binaryPairs = 0;
  for (const policy of policies) {
    await setImmediate();
    const binaries: Uint8Array[] = [];
    for (const program of [outcome.program, decodePreparedIrProgram(encoded)]) {
      await setImmediate();
      assertPreparedIrProgram(program);
      let calls = 0;
      for (const fn of program.ir.functions)
        for (const block of fn.blocks)
          for (const root of block.instrs)
            forEachInstrDeep(root, (instr: IrInstr) => {
              if (instr.kind === "call" && instr.resultType?.kind === "dynamic") calls++;
            });
      expect(calls).toBeGreaterThan(0);
      for (const view of program.runtime) {
        let selectedCalls = 0;
        for (const fn of view.prepared.functions)
          for (const block of fn.blocks)
            for (const instr of block.instrs)
              forEachInstrDeep(instr, (child) => {
                if (child.kind === "call" && child.resultType?.kind === "dynamic") selectedCalls++;
              });
        expect(selectedCalls).toBeGreaterThan(0);
      }
      const accepted = acceptPreparedIrProgram(program, {
        ...policy,
        moduleName: "ordinary-number-undefined",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      expect(accepted.kind).toBe("accepted");
      if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
      acceptedCount++;
      const binary = Uint8Array.from(emitBinary(emitAcceptedIrProgram(accepted).module));
      expect(WebAssembly.validate(binary)).toBe(true);
      const module = new WebAssembly.Module(binary);
      expect(WebAssembly.Module.imports(module)).toEqual([]);
      const instance = new WebAssembly.Instance(module, {});
      if (instance.exports._start) Reflect.apply(instance.exports._start as Function, undefined, []);
      for (let i = 0; i < fixture.args.length; i++) {
        expect(
          Object.is(Reflect.apply(instance.exports.run as Function, undefined, [fixture.args[i]]), expected[i]),
        ).toBe(true);
        executions++;
      }
      binaries.push(binary);
    }
    expect(binaries[0]).toEqual(binaries[1]);
    binaryPairs++;
  }
  expect(acceptedCount).toBe(8);
  expect(binaryPairs).toBe(4);
  expect(executions).toBe(fixture.args.length * 8);
  expect(reconstruction).not.toHaveBeenCalled();
  expect(oldGc).not.toHaveBeenCalled();
  expect(oldLinear).not.toHaveBeenCalled();
});
