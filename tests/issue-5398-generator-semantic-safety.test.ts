// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { collectUnsafeGeneratorSemantics } from "../src/compiler/generator-semantic-safety.js";

function diagnose(source: string, standalone = false) {
  const fileName = "/generator-safety.ts";
  const options = { target: ts.ScriptTarget.ES2022, strict: true };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion, true)
      : read(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], options, host);
  return collectUnsafeGeneratorSemantics(program.getTypeChecker(), program.getSourceFile(fileName)!, { standalone });
}

describe("#5398: measured generator and iterator limitations", () => {
  it.each([
    [
      "function* g(){var x=yield 1;yield x+1;}var it=g();it.next();it.next(2);",
      "JS2WASM_UNSUPPORTED_GENERATOR_SENT_VALUE",
    ],
    [
      'function* g(){var x=yield "ready";yield x;}var it=g();it.next();it.next("a");',
      "JS2WASM_UNSUPPORTED_GENERATOR_SENT_VALUE",
    ],
    [
      'function* g(){var x=yield "ready";while(x!=="stop"){x=yield 1;}}var it=g();it.next();it.next("stop");',
      "JS2WASM_UNSUPPORTED_GENERATOR_SENT_VALUE",
    ],
    [
      "function* a(){yield 1;return 7}function* b(){var x=yield* a();yield x}",
      "JS2WASM_UNSUPPORTED_GENERATOR_DELEGATION_RESULT",
    ],
    [
      'function* a(){yield "a";return "done"}function* b(){var x=yield* a();yield x}',
      "JS2WASM_UNSUPPORTED_GENERATOR_DELEGATION_RESULT",
    ],
    [
      "function make(){var x=0;return function*(){x++;yield x;x++;yield x}}",
      "JS2WASM_UNSUPPORTED_GENERATOR_CAPTURE_MUTATION",
    ],
    [
      "var a=[1,2];var it=a[Symbol.iterator]();it.next();a.push(3);it.next();",
      "JS2WASM_UNSUPPORTED_LIVE_ARRAY_ITERATOR",
    ],
  ])("reports an actionable source location for %s", (source, id) => {
    const reports = diagnose(source);
    const report = reports.find((item) => item.id === id);
    expect(report).toBeDefined();
    expect(report!.node.getSourceFile().fileName).toBe("/generator-safety.ts");
    expect(report!.node.getStart()).toBeGreaterThanOrEqual(0);
    expect(report!.message).toContain("#5398");
  });

  it.each([false, true])("rejects return yield* on standalone=%s", (standalone) => {
    expect(
      diagnose("function* a(){yield 1;return 7}function* b(){return yield* a()}", standalone).some(
        (report) => report.id === "JS2WASM_UNSUPPORTED_GENERATOR_DELEGATION_RESULT",
      ),
    ).toBe(true);
  });

  it("identifies the standalone explicit-array-iterator limitation separately from mutation", () => {
    const source = "var a=[1,2];var it=a[Symbol.iterator]();it.next();";
    expect(diagnose(source).map((item) => item.id)).toEqual([]);
    expect(diagnose(source, true).map((report) => report.id)).toEqual(["JS2WASM_UNSUPPORTED_EXPLICIT_ARRAY_ITERATOR"]);
  });

  it.each([
    "function* g(){yield 1;yield 2;}var it=g();it.next();it.next();",
    "function* g(){var x:number=yield 1;yield x;}var it=g();it.next();it.next(2);",
    "function* a(){yield 1;return 7}function* b(){yield* a();yield 2}",
    "function make(){var x=3;return function*(){yield x;yield x+1}}",
    "function make(){var x=3;return function*(){var x=0;x++;yield x}}",
    "var a=[1,2];a.push(3);var it=a[Symbol.iterator]();it.next();",
    "var a=[1,2];var it=a[Symbol.iterator]();it.next();a.push(3);",
    "var a=[1,2];var it=a[Symbol.iterator]();it.next();{var b=[3];b.push(4);}it.next();",
    "var a=[1,2];var it=a[Symbol.iterator]();function unused(){a.push(3)}it.next();",
    "var a=[1,2];var it=a[Symbol.iterator]();{let a=[4];a.push(3);}it.next();",
    "function f(Symbol:any){var a=[1,2];var it=a[Symbol.iterator]();a.push(3);it.next();}",
  ])("preserves supported shapes and unrelated-binding controls: %s", (source) => {
    expect(diagnose(source).map((item) => item.id)).toEqual([]);
  });

  it.each([
    "function* a(){yield 1;return 7}function* b(){var x=yield* a();yield x}",
    "function make(){var x=0;return function*(){x++;yield x;x++;yield x}}",
  ])("preserves the supported standalone form: %s", (source) => {
    expect(diagnose(source, true).map((item) => item.id)).toEqual([]);
  });
});
