// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7487 steps 1–2 — a call or `new` of the global `Function` whose arguments are all string literals becomes a
// `function` row of the literal dynamic-code relation (`src/ir/literal-dynamic-code.ts`): the script
// `<function:N>.js` holding one declaration `__js2wasm_dynamic_function_<N>`, built by `functionSourceText`.
//
// Blocked on #7363 A4, which is not implemented on this base: the site lowering (the fresh closure), the pristine
// proof with `ambientThisMayBeGlobal`, and the all-or-nothing fallback of the admission when a text's unit does not
// lower. Until then a reached site keeps today's refusal (pinned below), and the rows of the plan's acceptance list
// that need the site to run are not tested here. A site after `break` is never lowered, so its program compiles and
// shows the sources.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import {
  type LiteralDynamicCodeSource,
  literalDynamicCodeTexts,
  pairLiteralDynamicCodeSources,
  verifyLiteralDynamicCodeSources,
} from "../src/ir/literal-dynamic-code.js";
import { functionSourceText } from "../src/interp/function-source-text.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";

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
const SETTINGS = [
  ["semantic diagnostics", options],
  ["skipSemanticDiagnostics", { ...options, skipSemanticDiagnostics: true } as Test262CompileOptions],
] as const;

/** The texts the entry's `function` sites become. */
const functionTexts = (source: string) =>
  literalDynamicCodeTexts("test.js", source)
    .filter((row) => row.kind === "function")
    .map((row) => row.text);
/** Never-lowered sites. */
const deadSites = (...sites: string[]) => `do { break; ${sites.join(" ")} } while (false);`;
const named = (index: number, params: string, body: string) =>
  functionSourceText(`__js2wasm_dynamic_function_${index}`, params, body);

type Result = Awaited<ReturnType<typeof compile>>;
const errorsOf = (result: Result) =>
  result.errors.filter((error) => error.severity === "error").map((error) => error.message);

/** Compile without abort bodies, run startup, and report the program's sources. */
async function sourcesOf(source: string, settings: Test262CompileOptions = options) {
  const result = await compile(source, settings, undefined, "refuse");
  expect(errorsOf(result)).toEqual([]);
  (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
  return requiredPreparedEmission(result)!.units.sources.map((row) => row.file);
}

describe("#7487 — the function site predicate", () => {
  it("takes a call and a `new` of the global Function, with zero or more literal arguments", () => {
    expect(
      functionTexts('Function("return 1"); new Function("a", "b", "return a + b"); new Function; Function();'),
    ).toEqual([named(0, "", "return 1"), named(1, "a,b", "return a + b"), named(2, "", ""), named(3, "", "")]);
    // Anywhere in the entry: the function's scope is the global one, whatever the site's.
    expect(functionTexts("function f() { return Function(`return 2`); }")).toEqual([named(0, "", "return 2")]);
  });

  it("joins parameter pieces with commas and keeps sloppy duplicate parameters (valid)", () => {
    expect(functionTexts('Function("a,a", "return a")')).toEqual([named(0, "a,a", "return a")]);
    expect(functionTexts('Function("a", "b = 1", "...c", "")')).toEqual([named(0, "a,b = 1,...c", "")]);
  });

  it.each([
    ["a computed argument", "Function(x)"],
    ["a computed parameter piece", 'Function(p, "return 1")'],
    ["a local `var Function` shadow", 'var Function; Function("return 1")'],
    ["a parameter named Function", 'function f(Function) { return Function("1"); }'],
    ["a site inside `with`", 'with (o) { Function("return 1"); }'],
    ["an optional call", 'Function?.("return 1")'],
  ])("no site: %s", (_label, source) => {
    expect(functionTexts(source)).toEqual([]);
  });

  // P2: the separate-goal parses, checked by `fitsFunctionSourceText` on the assembled text. Each throws in node.
  it.each([
    ["parameters close early and the body opens a block", '"a) { if (1 //", "return 7 }"'],
    ["a block comment spans both pieces", '"/*", "*/){"'],
    ["the body closes the function and declares another", '"}; function x(){"'],
    ["the parameters close the function and start an expression", '"a){};(function(", ""'],
    ["a `)` in the parameters", '"a)", ""'],
  ])("no source for a SyntaxError of the separate parses: %s", (_label, args) => {
    expect(functionTexts(`Function(${args})`)).toEqual([]);
  });

  it.each([
    ["a strict legacy octal literal", `Function("'use strict'; 010")`],
    ["a strict `eval` parameter", `Function("eval", "'use strict'")`],
    ["a strict duplicate parameter", `Function("a,a", "'use strict'")`],
  ])("no source for a covered early error (the site throws once it lowers): %s", (_label, source) => {
    expect(functionTexts(source)).toEqual([]);
  });

  it.each([
    ["use-strict-non-simple-params", `Function("a = 1", "'use strict'")`],
    ["duplicate-label", 'Function("l: l: ;")'],
    ["strict-with", `Function("'use strict'; with (o) {}")`],
    ["super-outside-method", 'Function("super.x")'],
    ["super-outside-method (through an arrow)", 'Function("return () => super.x")'],
  ])("no source for an early error the shared check does not cover: %s", (_label, source) => {
    expect(functionTexts(source)).toEqual([]);
  });

  it("keeps the valid neighbours of those rules", () => {
    expect(functionTexts('Function("with (o) {}")')).toHaveLength(1);
    expect(functionTexts('Function("l: { m: ; } l: ;")')).toHaveLength(1);
    expect(functionTexts('Function("return ({ m() { return super.x; } })")')).toHaveLength(1);
    expect(functionTexts('Function("return new.target")')).toHaveLength(1);
  });

  it.each([
    ["`<!--` in the body", 'Function("", "x <!-- y")'],
    ["`<!--` in a parameter piece", 'Function("<!-- x", "")'],
    ["a line-leading `-->`", 'Function("", "\\n-->")'],
  ])("no source for an HTML-like comment: %s", (_label, source) => {
    expect(functionTexts(source)).toEqual([]);
  });

  it.each([
    ["a store into a global", 'Function("x = 1")'],
    ["a `var` (RV7432 B2 fix (b) refuses it for both kinds)", 'Function("var x = 1; return x")'],
    ["the name eval", 'Function("return eval")'],
    ["the reserved prefix", 'Function("return __js2wasm_dynamic_function_1")'],
  ])("no source for a body the eval rules refuse: %s", (_label, source) => {
    expect(functionTexts(source)).toEqual([]);
  });
});

describe("#7487 — the virtual source", () => {
  it.each(SETTINGS)("one script per site, after the entry, beside the eval sources (%s)", async (_s, settings) => {
    const entry = deadSites('Function("a", "return a");', 'eval("1");', 'new Function("return 2");');
    expect(await sourcesOf(entry, settings)).toEqual(["test.js", "<eval:0>.js", "<function:0>.js", "<function:1>.js"]);
  });

  it.each(SETTINGS)("binds no name user code sees (%s)", async (_s, settings) => {
    const entry = `var anonymous = 1;\n${deadSites('Function("return typeof anonymous");', 'Function("a", "return a");')}
      if (anonymous !== 1) throw 1;`;
    expect(await sourcesOf(entry, settings)).toEqual(["test.js", "<function:0>.js", "<function:1>.js"]);
  });

  it("keeps the entry the only startup source: a script var and a function value keep their homes", async () => {
    const entry = `var x = 1; function g() { return x; } var h = g;\n${deadSites('Function("return x");')}
      if (h() !== 1) throw 1;`;
    expect(await sourcesOf(entry)).toEqual(["test.js", "<function:0>.js"]);
  });

  it("takes a strict program's site as a sloppy-by-default function", async () => {
    expect(await sourcesOf(`"use strict";\n${deadSites('Function("return 1");')}`)).toEqual([
      "test.js",
      "<function:0>.js",
    ]);
  });

  it("refuses a program that spells the reserved prefix beside a site, by name", async () => {
    const entry = `function __js2wasm_dynamic_function_0() {}\n${deadSites('Function("return 1");')}`;
    expect(errorsOf(await compile(entry, options, undefined, "refuse"))).toEqual([
      "identifier uses the reserved dynamic-function prefix",
    ]);
    // Without a site nothing is synthesized, so the program compiles as before.
    expect(await sourcesOf("function __js2wasm_dynamic_function_0() {}\n__js2wasm_dynamic_function_0();")).toEqual([
      "test.js",
    ]);
  });
});

describe("#7487 — the receipt", () => {
  const program = (entry: string) => {
    const texts = literalDynamicCodeTexts("test.js", entry);
    const files: Record<string, string> = { "test.js": entry };
    for (const { name, text } of texts) files[name] = text;
    const ast = analyzeMultiSource(files, "test.js", undefined, { allowJs: true });
    return { ast, rows: pairLiteralDynamicCodeSources(ast.entryFile, ast.sourceFiles, texts.length) };
  };
  const verify = (rows: readonly LiteralDynamicCodeSource[], ast: ReturnType<typeof analyzeMultiSource>) => () =>
    verifyLiteralDynamicCodeSources(rows, ast.sourceFiles, ast.entryFile);

  it("accepts the real relation; only the eval rows are called", () => {
    const { ast, rows } = program('Function("return 1");\neval("2");');
    expect(rows.map((row) => [row.kind, row.source.fileName])).toEqual([
      ["function", "<function:0>.js"],
      ["eval", "<eval:0>.js"],
    ]);
    const related = verify(rows, ast)();
    expect([...related.sources]).toEqual(rows.map((row) => row.source));
    expect([...related.calledSources]).toEqual([rows[1]!.source]);
    expect([...related.evalCalls]).toEqual([[rows[1]!.site, rows[1]!.source]]);
  });

  it("refuses a row whose kind is not the site's", () => {
    const { ast, rows } = program('Function("return 1");');
    expect(verify([{ ...rows[0]!, kind: "eval" }], ast)).toThrow(/the site is not a qualifying eval site/);
  });

  it("refuses a source whose text is not the site's", () => {
    const { ast, rows } = program('Function("return 1");\nFunction("return 2");');
    expect(verify([{ ...rows[0]!, source: rows[1]!.source }], ast)).toThrow(/the source text is not the site's text/);
  });
});

describe("#7487 — a reached site, until #7363 A4 lowers it", () => {
  it("keeps today's refusal for a call and for `new`", async () => {
    expect(errorsOf(await compile('Function("return 1")();', options, undefined, "refuse"))).toEqual([
      'ir/from-ast: direct call to "Function" has no exact AST-site plan in <module-init>',
    ]);
    expect(errorsOf(await compile('new Function("return 1");', options, undefined, "refuse"))).toEqual([
      'ir/from-ast: unknown class "Function" in <module-init>',
    ]);
  });
});
