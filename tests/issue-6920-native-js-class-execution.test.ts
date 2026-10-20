// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { analyzeMultiSource } from "../src/checker/index.js";
import { ts } from "../src/ts-api.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
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
it.each(cases)("executes actual class declaration startup GC %s through %s", async (target, transport) => {
  await yieldTurn();
  const policy = { backend: "wasmgc" as const, target };
  if (transport === "prepare") {
    const text = "class C{}export function run():number{return 1;}";
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
    codecPrograms.set(target, decoded);
    await yieldTurn();
    return;
  }
  const program = transport === "live" ? fixture.program : codecPrograms.get(target);
  if (!program) throw Error("missing genuine codec phase for " + target);
  await yieldTurn();
  const poison = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
    throw Error("source reconstruction is forbidden");
  });
  try {
    const accepted = acceptPreparedIrProgram(program, {
      ...policy,
      moduleName: "class-startup",
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
    });
    if (accepted.kind !== "accepted") throw Error(JSON.stringify(accepted));
    const emitted = emitAcceptedIrProgram(accepted),
      binary = new Uint8Array(emitBinary(emitted.module));
    const instance = new WebAssembly.Instance(new WebAssembly.Module(binary.buffer), {});
    if (target === "wasi") (instance.exports._start as () => void)();
    expect((instance.exports.run as () => number)()).toBe(fixture.expected);
    expect(poison).not.toHaveBeenCalled();
    if (transport === "live") liveBinaries.set(target, new Uint8Array(binary));
    else {
      expect(liveBinaries.has(target)).toBe(true);
      expect(binary).toEqual(liveBinaries.get(target)!);
    }
  } finally {
    poison.mockRestore();
  }
  await yieldTurn();
});
