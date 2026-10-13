// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { completedLinearMemorySupportKeys } from "../src/compiler/ir-program-memory-presentation.js";

function emitted() {
  const ast = analyzeMultiSource(
    {
      "./entry.ts":
        "export function run(a:number,b:number):number{const values=[a,b];return values[0]+values[1]+values.length;}",
    },
    "./entry.ts",
  );
  const prepared = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "linear", target: "standalone" },
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
  const options = {
    backend: "linear",
    target: "standalone",
    moduleName: "memory-presentation-controls",
    sourceMap: false,
    utf8Storage: false,
    sharedExceptionTag: false,
  } as const;
  const accepted = acceptPreparedIrProgram(prepared.program, options);
  if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
  return { emission: emitAcceptedIrProgram(accepted), options };
}
it("joins all four genuinely completed numeric memory helper coordinates", () => {
  const { emission, options } = emitted();
  expect(completedLinearMemorySupportKeys(emission, options)).toEqual([
    "linear:malloc",
    "linear:array-new",
    "linear:initialize-element",
    "linear:resolve-forwarding",
  ]);
});
it("refuses a mismatched physical target and altered actual memory bound", () => {
  const { emission, options } = emitted();
  expect(completedLinearMemorySupportKeys(emission, { ...options, target: "wasi" })).toBeUndefined();
  emission.module.memories[0]!.min++;
  expect(() => completedLinearMemorySupportKeys(emission, options)).toThrow(/altered memory descriptor linear:memory/);
});
it("refuses a memory export moved away from its reserved coordinate", () => {
  const { emission, options } = emitted();
  const memory = emission.module.exports.find((row) => row.desc.kind === "memory")!;
  memory.desc.index = 1;
  expect(() => completedLinearMemorySupportKeys(emission, options)).toThrow(/altered publication descriptor/);
});
