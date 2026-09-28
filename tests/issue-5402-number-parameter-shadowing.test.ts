// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { collectUnsafeBuiltinShadowing } from "../src/compiler/builtin-shadow-semantic-safety.js";

function diagnose(source: string) {
  const fileName = "/number-shadow.ts";
  const options = { target: ts.ScriptTarget.ES2022 };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : read(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], options, host);
  return collectUnsafeBuiltinShadowing(program.getTypeChecker(), program.getSourceFile(fileName)!);
}

describe("#5402: Number parameter dispatch", () => {
  it.each([
    "function f(Number){return Number([1]);}console.log(f(x=>7));",
    "function f(Number:(x:number[])=>number){return Number([1]);}",
    "const f=(Number:(x:number)=>number)=>Number(1);",
    "function f(Number){return ()=>Number(1);}",
    // The builtin happens to agree with this identity callback; the binding remains unsupported.
    "function f(Number){return Number(1);}console.log(f(x=>x));",
  ])("rejects a resolved Number parameter call: %s", (source) => {
    const reports = diagnose(source);
    expect(reports.map((report) => report.id)).toEqual(["JS2WASM_UNSUPPORTED_NUMBER_PARAMETER_CALL"]);
    expect(reports[0]!.node.getSourceFile().fileName).toBe("/number-shadow.ts");
    expect(reports[0]!.node.getText()).toMatch(/^Number\(/);
  });

  it.each([
    "function f(convert){return convert([1]);}console.log(f(x=>7));",
    "console.log(Number(1));",
    "function f(Number){return Number;}",
    "const Number=(x:number)=>x;Number(1);",
    "function f(Number){function inner(){const Number=(x:number)=>x;return Number(1);}return inner();}",
    "function f(Number){return {Number:1};}",
  ])("does not classify other bindings or non-call uses: %s", (source) => {
    expect(diagnose(source).map((report) => report.id)).toEqual([]);
  });
});
