// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7487 — one §20.2.1.1.1 assembler (`functionSourceText`) for the interpreter and the compile-time fold of a literal
// `Function(...)`. The fold's own template put no newline before `)`, so a trailing line comment in the parameter text
// swallowed the `)` and the fold declined; it now folds, and answers as node does.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { dynamicFunctionSource } from "../src/interp/dynamic-function.js";
import { functionSourceText } from "../src/interp/function-source-text.js";
import { evaluateAsJs, instantiateWithRuntime } from "./equivalence/helpers.js";

describe("#7487 functionSourceText", () => {
  it("is CreateDynamicFunction's text, and the interpreter's", () => {
    expect(functionSourceText("anonymous", "a //", "return 1")).toBe("function anonymous(a //\n) {\nreturn 1\n}");
    expect(dynamicFunctionSource("a,b", "return a")).toBe(functionSourceText("anonymous", "a,b", "return a"));
  });

  it.each([
    ["a trailing line comment in the parameter text", `new Function("a //", "return 1")`],
    ["a trailing line comment in the body", `new Function("a", "return 2 // trailing")`],
  ])(
    "%s answers as node does on gc and standalone",
    async (_name, expr) => {
      const source = `export function test(): number { const f: any = ${expr}; return f(5); }`;
      const expected = evaluateAsJs(source).test!();
      for (const options of [{}, { target: "standalone" as const }]) {
        const result = await compile(source, { fileName: "probe.ts", ...options });
        expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
        const instance = await instantiateWithRuntime(result);
        expect((instance.exports.test as () => unknown)()).toBe(expected);
      }
    },
    60_000,
  );
});
