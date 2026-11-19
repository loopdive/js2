// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7363 slice 1 — an eval statement on the Prepared path refused with an invariant error ("certified global eval lost
// an owning predicate"), which crashed compile() on 195 ES5 files. The Prepared resolver has no eval provider, so the
// statement now refuses by name; an `eval` bound in scope is an ordinary callee and never reaches that refusal.
import { describe, expect, it } from "vitest";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";

const options = {
  wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
  backend: "wasmgc",
  target: "standalone",
  sourceMap: false,
  optimize: false,
  emitWat: false,
  fileName: "test.js",
  allowJs: true,
} as Test262CompileOptions;

const REFUSAL = "eval statement has no eval provider";
const messages = async (source: string) => (await compile(source, options)).errors.map((error) => error.message);

describe("#7363 slice 1 — an eval statement on the Prepared path refuses by name", () => {
  it.each([
    ["a literal at top level", 'eval("1");', "<module-init>"],
    ["a declaration in a function", 'function f() { eval("var y = 1"); }\nf();', "f"],
    ["a computed source", 'var s = "1";\neval(s);', "<module-init>"],
    ["the indirect (0, eval) spelling", '(0, eval)("1");', "<module-init>"],
  ])("refuses %s", async (_label, source, owner) => {
    expect(await messages(source)).toEqual([`ir/from-ast: ${REFUSAL} in ${owner}`]);
  });

  it("lowers an eval parameter as an ordinary call", async () => {
    const errors = await messages('function f(eval) { eval("1"); }\nf(function (v) { return v; });');
    expect(errors.join("\n")).not.toContain(REFUSAL);
    expect(errors.join("\n")).not.toContain("owning predicate");
  });
});
