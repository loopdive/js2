// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7487 — a call or `new` of the global `Function` whose arguments are all string literals becomes a `function` row
// of the literal dynamic-code relation (`src/ir/literal-dynamic-code.ts`): the script `<function:N>.js` holding one
// declaration `__js2wasm_dynamic_function_<N>`, built by `functionSourceText`. The site evaluates to a fresh function
// object of that declaration named "anonymous" (`literal-dynamic-code-lowering.ts`), while the global `Function` is
// pristine (#7363 A4's proof); otherwise it refuses at select by name. A site after `break` is never lowered, so its
// program compiles and shows the sources.
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
const NO_SITE_PLAN = 'ir/from-ast: direct call to "Function" has no exact AST-site plan in <module-init>';
const NO_EVAL_PROVIDER = "ir/from-ast: eval statement has no eval provider in <module-init>";
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

  // The parse and the shared check do not report these; the compile's own gates do on the joined source, as for an
  // eval text, so no source joins and the site keeps today's refusal.
  it.each([
    ['`"use strict"` with non-simple parameters', `Function("a = 1", "'use strict'")`],
    ["a duplicate label", 'Function("l: l: ;")'],
    ["strict `with`", `Function("'use strict'; with (o) {}")`],
    ["`super` outside a method", 'Function("super.x")'],
    ["`super` through an arrow", 'Function("return () => super.x")'],
  ])("an early error only the compile's gates report: %s", async (_label, source) => {
    for (const [, settings] of SETTINGS)
      expect(errorsOf(await compile(source, settings, undefined, "refuse"))).toEqual([NO_SITE_PLAN]);
  });

  // Annex B.1.1: TypeScript parses `a <!--b` as `a < !(--b)`, so a text that may hold one makes no source, for both
  // kinds (`hasHtmlLikeComment`), and the site keeps today's refusal.
  it.each([
    ["`<!--` in a Function body", 'Function("", "x <!-- y")', NO_SITE_PLAN],
    ["`<!--` in a Function parameter piece", 'Function("<!-- x", "")', NO_SITE_PLAN],
    ["a line-leading `-->` in a Function body", 'Function("", "\\n--> x")', NO_SITE_PLAN],
    ["`<!--` in an eval text", 'eval("1 <!-- x");', NO_EVAL_PROVIDER],
    ["a line-leading `-->` in an eval text", 'eval("\\n--> x");', NO_EVAL_PROVIDER],
  ])("no source for an HTML-like comment: %s", async (_label, source, label) => {
    expect(literalDynamicCodeTexts("test.js", source)).toEqual([]);
    expect(errorsOf(await compile(source, options, undefined, "refuse"))).toEqual([label]);
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
    return { ast, rows: pairLiteralDynamicCodeSources(ast.entryFile, ast.sourceFiles, texts) };
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

/** Compile without abort bodies and run startup: the program's own checks throw on a wrong answer. */
async function runs(source: string, settings: Test262CompileOptions = options): Promise<"ran" | "threw"> {
  const result = await compile(source, settings, undefined, "refuse");
  expect(errorsOf(result)).toEqual([]);
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return "ran";
  } catch {
    return "threw";
  }
}
const NOT_PRISTINE = "ir/from-ast: Function literal: the global Function is not pristine (#7487) in <module-init>";
const SKIP_SEMANTIC = SETTINGS[1][1];

describe("#7487 — a pristine site evaluates to a fresh function object", () => {
  it.each([
    ["a call", 'if (Function("return 1")() !== 1) throw 1;'],
    ["`new`", 'if (new Function("a", "b", "return a + b")(1, 2) !== 3) throw 1;'],
    ["sloppy duplicate parameters", 'if (Function("a,a", "return a")(1, 2) !== 2) throw 1;'],
    [
      "a fresh object per evaluation, named anonymous",
      'function g() { return Function("return 1"); }\nvar a = g(), b = g();\nif (a === b || a.name !== "anonymous") throw 1;',
    ],
    [
      "no global `anonymous` after a site runs",
      'Function("return 1")();\nif (typeof anonymous !== "undefined") throw 1;',
    ],
    ["no `anonymous` inside the body", 'if (Function("return typeof anonymous")() !== "undefined") throw 1;'],
    [
      "a user `var anonymous` and two sites",
      'var anonymous = 1;\nvar f = Function("return 2"), g = Function("a", "return a");\nif (f() !== 2 || g(3) !== 3 || anonymous !== 1) throw 1;',
    ],
    ["a read of a caller global", 'var x = 1;\nif (Function("return x + 1")() !== 2) throw 1;'],
    ["constructing the value", 'var C = Function("this.a = 1");\nif (new C().a !== 1) throw 1;'],
    ["a strict body in a sloppy program", `if (Function("'use strict'; return 1")() !== 1) throw 1;`],
    ["a sloppy-by-default body in a strict program", `"use strict";\nif (Function("return 1")() !== 1) throw 1;`],
    ["a site in a loop", 'for (var i = 0; i < 3; i++) if (Function("a", "return a * 2")(i) !== i * 2) throw 1;'],
  ])("%s agrees with node", async (_label, source) => {
    for (const [, settings] of SETTINGS) expect(await runs(source, settings)).toBe("ran");
  });

  it("reports no diagnostic for sloppy duplicate parameters, which are valid JavaScript", async () => {
    const result = await compile('Function("a,a", "return a")(1, 2);', options, undefined, "refuse");
    expect(result.errors.map((error) => error.message)).toEqual([]);
  });

  it("checks its answer: a wrong expectation throws", async () => {
    expect(await runs('if (Function("return 1")() !== 2) throw 1;')).toBe("threw");
  });

  it.each([
    ["an assignment", "Function = function () {};"],
    ["a compound assignment", 'Function += "";'],
    ["a destructuring target", "[Function] = [0];"],
    ["`delete`", "delete Function;"],
    ["a write through globalThis", "globalThis.Function = function () {};"],
    ["a write through script `this`", "this.Function = 1;"],
    ["a sloppy function whose own `this` escapes", "function f() { return this; }\nvar h = f;\nh();"],
    ["a dynamic body whose own `this` escapes", 'Function("return this");'],
  ])("refuses by name when the program has %s", async (_label, rest) => {
    const source = `Function("return 1");\n${rest}`;
    expect(errorsOf(await compile(source, SKIP_SEMANTIC, undefined, "refuse"))).toEqual([NOT_PRISTINE]);
  });

  it("makes an eval site refuse when a dynamic body lets its own `this` escape", async () => {
    expect(errorsOf(await compile('eval("1");\nFunction("return this");', options, undefined, "refuse"))).toEqual([
      "ir/from-ast: eval literal: the global eval is not pristine (#7363 A4) in <module-init>",
    ]);
  });

  it("leaves a shadowing `var Function` an ordinary call", async () => {
    expect(
      errorsOf(await compile('var Function = function () {};\nFunction("return 1");', options, undefined, "refuse")),
    ).toEqual(['ir/from-ast: direct call to "Function" has no exact AST-site plan in <module-init>']);
  });

  it("keeps today's refusal for a site that is none", async () => {
    for (const source of ["var p = 1;\nFunction(p);", `Function("'use strict'; 010");`, 'Function("l: l: ;");'])
      expect(errorsOf(await compile(source, SKIP_SEMANTIC, undefined, "refuse"))).toEqual([
        'ir/from-ast: direct call to "Function" has no exact AST-site plan in <module-init>',
      ]);
  });
});

describe("#7487 — claimed only when the source's unit lowered (#7363 A4's admission)", () => {
  const binary = async (source: string) => (await compile(source, options, undefined, "refuse")).binary;

  // RV-PR7556 finding 5: a failing Function text must not take the eval texts with it.
  it.each(SETTINGS)("keeps the eval texts when a Function text fails (%s)", async (_setting, settings) => {
    const source = 'eval("1;");\ndo { break; Function("return arguments[1]"); } while (false);';
    expect(await sourcesOf(source, settings)).toEqual(["test.js", "<eval:0>.js"]);
  });

  it("compiles a never-run site whose body does not lower exactly as without the site", async () => {
    // `b = 1`: a default parameter, not in the IR's scope. The parenthesized argument is no site.
    const site = await binary(deadSites('Function("b = 1", "return b");'));
    const none = await binary(deadSites('Function(("b = 1"), "return b");'));
    expect(site).toBeDefined();
    expect(site).toEqual(none);
  });

  it("answers a reached site whose body does not lower with the body's own refusal", async () => {
    expect(errorsOf(await compile('Function("b = 1", "return b")();', options, undefined, "refuse"))).toEqual([
      "ir/from-ast: rest/default/optional param not in Phase 1 IR scope (__js2wasm_dynamic_function_0)",
    ]);
  });
});

describe("#7487 — gaps left by name", () => {
  it("constructs a parenthesized site only through a binding (today's constructor-name refusal)", async () => {
    expect(errorsOf(await compile('new (Function("this.a = 1"))();', options, undefined, "refuse"))).toEqual([
      "ir/from-ast: only direct constructor names supported in slice 4 (<module-init>)",
    ]);
  });

  // Not a named refusal yet: `Function.prototype.toString` does not exist on this path, and a function object made
  // from a declaration traps at run time on it, as an F1b declaration value does (`function k(){} var g = k;`).
  it("traps on toString(), as every declaration's function object does", async () => {
    expect(await runs('var f = Function("return 1");\nf.toString();')).toBe("threw");
  });
});
