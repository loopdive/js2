// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import * as constructionRecipes from "../src/backend/wasmgc/resources/native-js-class.js";
import * as directGc from "../src/codegen/index.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as astLowerer from "../src/ir/from-ast.js";
import * as sourceProducer from "../src/ir/program-source.js";

const fixtures = new Map<string, { program: ReturnType<typeof decodePreparedIrProgram>; expected: number }>();
const codecPrograms = new Map<string, ReturnType<typeof decodePreparedIrProgram>>();
const liveBinaries = new Map<string, Uint8Array>();
const cases = [
  ["standalone", "prepare"],
  ["standalone", "roundtrip"],
  ["standalone", "live"],
  ["standalone", "codec"],
  ["wasi", "prepare"],
  ["wasi", "roundtrip"],
  ["wasi", "live"],
  ["wasi", "codec"],
] as const;
it.each(cases)("executes actual empty explicit constructor GC %s through %s", async (target, transport) => {
  await yieldTurn();
  const policy = { backend: "wasmgc" as const, target };
  const durations: Record<string, number> = {};
  let boundary = performance.now();
  const mark = (stage: string) => {
    const now = performance.now();
    durations[stage] = now - boundary;
    boundary = now;
  };
  const report = () => console.info("construction-phases", JSON.stringify({ target, transport, durations }));
  if (transport === "prepare") {
    const text = "class A{constructor(){}}export function run():number{new A();return 1;}";
    const javascript = ts.transpileModule(text, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const reference: { run?: () => number } = {};
    new Function("exports", javascript)(reference);
    const expected = reference.run!();
    expect(expected).toBe(1);
    const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
    const prepared = prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: [policy],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
    mark("preparation");
    report();
    fixtures.set(target, { program: prepared.program, expected });
    await yieldTurn();
    return;
  }
  const fixture = fixtures.get(target);
  if (!fixture) throw Error("missing genuinely prepared source phase for " + target);
  if (transport === "roundtrip") {
    const encoded = encodePreparedIrProgram(fixture.program),
      decoded = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(decoded)).toBe(encoded);
    mark("codec");
    report();
    codecPrograms.set(target, decoded);
    await yieldTurn();
    return;
  }
  const program = transport === "live" ? fixture.program : codecPrograms.get(target);
  if (!program) throw Error("missing genuine codec phase for " + target);
  for (const functions of [program.ir.functions, ...program.runtime.map((view) => view.prepared.functions)]) {
    let constructs = 0;
    for (const fn of functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (instruction) => {
            if (instruction.kind === "js.class.construct") constructs++;
          });
    expect(constructs).toBe(1);
  }
  const recipe = vi.spyOn(constructionRecipes, "emitNativeJsClassGcConstruction");
  await yieldTurn();
  const poison = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
    throw Error("source reconstruction is forbidden");
  });
  const noGc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
    throw Error("direct GC reconstruction forbidden");
  });
  const noLinear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
    throw Error("direct Linear reconstruction forbidden");
  });
  const noClassBody = vi.spyOn(astLowerer, "lowerNativeJsClassBodyToIr").mockImplementation(() => {
    throw Error("source class body reconstruction forbidden");
  });
  const noClassModule = vi.spyOn(astLowerer, "lowerNativeJsClassModuleToIr").mockImplementation(() => {
    throw Error("source class module reconstruction forbidden");
  });
  try {
    mark("census-and-source-poison");
    const accepted = acceptPreparedIrProgram(program, {
      ...policy,
      moduleName: "class-construction",
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
    });
    if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
    mark("acceptance");
    const emitted = emitAcceptedIrProgram(accepted);
    mark("emission");
    const binary = new Uint8Array(emitBinary(emitted.module));
    mark("binary");
    const instance = new WebAssembly.Instance(new WebAssembly.Module(binary.buffer), {});
    if (target === "wasi") (instance.exports._start as () => void)();
    expect((instance.exports.run as () => number)()).toBe(fixture.expected);
    mark("engine");
    report();
    for (const reconstruction of [poison, noGc, noLinear, noClassBody, noClassModule])
      expect(reconstruction).not.toHaveBeenCalled();
    expect(recipe).toHaveBeenCalledTimes(1);
    const actualCall = recipe.mock.calls[0]!;
    expect(actualCall[3]).toHaveLength(1);
    expect(actualCall[4]).toHaveLength(1);
    expect(actualCall[5]).toHaveLength(2);
    if (transport === "live") liveBinaries.set(target, new Uint8Array(binary));
    else {
      expect(liveBinaries.has(target)).toBe(true);
      expect(binary).toEqual(liveBinaries.get(target)!);
    }
  } finally {
    for (const reconstruction of [poison, noGc, noLinear, noClassBody, noClassModule]) reconstruction.mockRestore();
    recipe.mockRestore();
  }
  await yieldTurn();
});

const argumentFixtures = new Map<string, { program: ReturnType<typeof decodePreparedIrProgram>; expected: number }>();
const argumentCodecs = new Map<string, ReturnType<typeof decodePreparedIrProgram>>();
const argumentBinaries = new Map<string, Uint8Array>();
it.each(cases)(
  "executes genuine missing and extra constructor arguments GC %s through %s",
  async (target, transport) => {
    await yieldTurn();
    const policy = { backend: "wasmgc" as const, target };
    if (transport === "prepare") {
      const text =
        "let count:number=0;function bump():number{count=count+1;return count;}class A{constructor(value:number){}}export function run():number{new A();new A(bump(),bump());return count;}";
      const javascript = ts.transpileModule(text, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const reference: { run?: () => number } = {};
      new Function("exports", javascript)(reference);
      const expected = reference.run!();
      expect(expected).toBe(2);
      const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
      const prepared = prepareWholeIrProgram({
        sourceFiles: ast.sourceFiles,
        entrySource: ast.entryFile,
        checker: ast.checker,
        policy,
        runtimePolicies: [policy],
        deferTopLevelInit: false,
        linearVectorProjection: "native-f64",
      });
      if (prepared.kind !== "prepared") throw Error(JSON.stringify(prepared));
      argumentFixtures.set(target, { program: prepared.program, expected });
      await yieldTurn();
      return;
    }
    const fixture = argumentFixtures.get(target);
    if (!fixture) throw Error("missing actual argument source preparation");
    if (transport === "roundtrip") {
      const encoded = encodePreparedIrProgram(fixture.program),
        decoded = decodePreparedIrProgram(encoded);
      expect(encodePreparedIrProgram(decoded)).toBe(encoded);
      argumentCodecs.set(target, decoded);
      await yieldTurn();
      return;
    }
    const program = transport === "live" ? fixture.program : argumentCodecs.get(target);
    if (!program) throw Error("missing actual argument codec phase");
    for (const functions of [program.ir.functions, ...program.runtime.map((view) => view.prepared.functions)]) {
      const lengths: number[] = [];
      for (const fn of functions)
        for (const block of fn.blocks)
          for (const root of block.instrs)
            forEachInstrDeep(root, (instruction) => {
              if (instruction.kind === "js.class.construct") lengths.push(instruction.args.length);
            });
      expect(lengths).toEqual([0, 2]);
    }
    const recipe = vi.spyOn(constructionRecipes, "emitNativeJsClassGcConstruction");
    const source = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
      throw Error("source reconstruction forbidden");
    });
    const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw Error("direct GC forbidden");
    });
    const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
      throw Error("direct Linear forbidden");
    });
    const body = vi.spyOn(astLowerer, "lowerNativeJsClassBodyToIr").mockImplementation(() => {
      throw Error("source body forbidden");
    });
    const moduleSource = vi.spyOn(astLowerer, "lowerNativeJsClassModuleToIr").mockImplementation(() => {
      throw Error("source module forbidden");
    });
    const start = performance.now();
    try {
      const accepted = acceptPreparedIrProgram(program, {
        ...policy,
        moduleName: "class-arguments",
        sharedExceptionTag: false,
        utf8Storage: false,
        sourceMap: false,
      });
      if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
      const acceptedAt = performance.now(),
        emitted = emitAcceptedIrProgram(accepted),
        emittedAt = performance.now();
      const binary = new Uint8Array(emitBinary(emitted.module));
      const instance = new WebAssembly.Instance(new WebAssembly.Module(binary.buffer), {});
      if (target === "wasi") (instance.exports._start as () => void)();
      expect((instance.exports.run as () => number)()).toBe(fixture.expected);
      for (const reconstruction of [source, gc, linear, body, moduleSource])
        expect(reconstruction).not.toHaveBeenCalled();
      expect(recipe).toHaveBeenCalledTimes(2);
      expect(recipe.mock.calls.map((call) => call[5].length)).toEqual([2, 4]);
      for (const call of recipe.mock.calls) expect(call[3][0]!.parameters).toBe(1);
      const call = recipe.mock.calls[0]!,
        result = recipe.mock.results[0]!;
      if (result.type !== "return") throw Error("actual construction recipe did not return");
      const importFunctions = emitted.module.imports.filter((row) => row.desc.kind === "func").length;
      const userIndex = importFunctions + emitted.module.functions.indexOf(call[3][0]!.body.object);
      const importGlobals = emitted.module.imports.filter((row) => row.desc.kind === "global").length;
      const undefinedIndex = importGlobals + emitted.module.globals.indexOf(call[1].undefinedValue.object);
      expect(userIndex).toBeGreaterThanOrEqual(importFunctions);
      expect(undefinedIndex).toBeGreaterThanOrEqual(importGlobals);
      const found: import("../src/wasm/model/instructions.js").Instr[][] = [];
      const inspect = (rows: readonly import("../src/wasm/model/instructions.js").Instr[]) => {
        for (const row of rows)
          if (row.op === "if") {
            if (row.then.some((nested) => nested.op === "call" && nested.funcIdx === userIndex)) found.push(row.then);
            inspect(row.then);
            inspect(row.else ?? []);
          }
      };
      inspect(result.value);
      expect(found).toHaveLength(1);
      const branch = found[0]!,
        index = branch.findIndex((row) => row.op === "call" && row.funcIdx === userIndex);
      expect(branch[index - 1]).toEqual({ op: "global.get", index: undefinedIndex });
      if (transport === "live") argumentBinaries.set(target, new Uint8Array(binary));
      else {
        expect(argumentBinaries.has(target)).toBe(true);
        expect(binary).toEqual(argumentBinaries.get(target)!);
      }
      console.info(
        "argument-construction-phases",
        JSON.stringify({
          target,
          transport,
          acceptance: acceptedAt - start,
          emission: emittedAt - acceptedAt,
          rest: performance.now() - emittedAt,
        }),
      );
    } finally {
      for (const reconstruction of [source, gc, linear, body, moduleSource]) reconstruction.mockRestore();
      recipe.mockRestore();
    }
    await yieldTurn();
  },
);
