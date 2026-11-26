// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7487 — one §20.2.1.1.1 assembler (`functionSourceText`) for the interpreter and the compile-time fold of a literal
// `Function(...)`. The fold's own template put no newline before `)`, so a trailing line comment in the parameter text
// swallowed the `)` and the fold declined; it now folds, and answers as node does.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import ts from "typescript";
import { compileDynamicFunctionMeta, dynamicFunctionSource } from "../src/interp/dynamic-function.js";
import { fitsFunctionSourceText, functionSourceText } from "../src/interp/function-source-text.js";
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

  // §20.2.1.1.1 parses the parameters and the body as separate goals: text that only parses run together is a
  // SyntaxError (node: `new Function("a) { if (1 //", "return 7 }")` throws), so neither route may accept it.
  const INJECTIONS: readonly [string, string, string][] = [
    ["parameters close early and the body opens a block (RV7441)", "a) { if (1 //", "return 7 }"],
    ["a block comment spans both", "/*", "*/){"],
    ["the body closes the function and declares another", "", "}; function x(){"],
    ["the parameters close the function and start an expression", "a){};(function(", ""],
    ["a `)` in the parameters", "a)", "return 1"],
  ];
  const fits = (params: string, body: string): boolean => {
    const text = functionSourceText("anonymous", params, body);
    const sf = ts.createSourceFile("f.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const fn = sf.statements[0];
    if (!fn || !ts.isFunctionDeclaration(fn) || !fn.body) return false;
    return fitsFunctionSourceText(text, "anonymous", params, sf.statements.length, fn.body.getStart(sf), fn.body.end);
  };

  it.each(INJECTIONS)("rejects %s", (_name, params, body) => {
    expect(fits(params, body)).toBe(false);
  });

  it.each([
    ["a,b", "return a + b"],
    ["a //", "return 1"],
    ["a = {}", "return a"],
    ["", ""],
  ])("accepts (%j, %j)", (params, body) => {
    expect(fits(params, body)).toBe(true);
  });

  it("the fold declines an injection instead of answering it", async () => {
    const source = `export function test(): number { const f: any = new Function("a) { if (1 //", "return 7 }"); return f(); }`;
    const result = await compile(source, { fileName: "probe.ts", target: "standalone" });
    expect(result.success).toBe(true);
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map((entry) => entry.module);
    expect(imports).toContain("js2wasm:runtime-eval");
  });

  it("the interpreter throws SyntaxError when the parsed body is not the one the assembler wrote", () => {
    const params = "a) { if (1 //";
    const body = "return 7 }";
    const text = dynamicFunctionSource(params, body);
    const parse = () => ({
      body: [{ type: "FunctionDeclaration", body: { start: text.indexOf("{"), end: text.length } }],
    });
    expect(() => compileDynamicFunctionMeta(parse, params, body)).toThrow(SyntaxError);
  });
});
