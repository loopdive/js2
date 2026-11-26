// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7363 slice A, review RV7432 — which literal eval texts join the program as `<eval:N>.js`.
// - B1: a text joins only when the compile's gates pass it as they pass a JavaScript entry (syntax, hard type and
//   early-error gates; any other diagnostic, such as a read of an undeclared global, is tolerated) and it changes no
//   other source's diagnostics. Otherwise none joins and every site keeps its slice-1 refusal, so the program
//   compiles, or refuses, exactly as on main. Both diagnostic settings are covered: the test262 lane skips semantic
//   diagnostics.
// - B2: a text that stores into an identifier is no site. The proofs over a script binding walk only its own file,
//   so a write in the text would go unseen.
// A site after `break` is never lowered, so its program compiles on main.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { literalEvalFileName, literalEvalTexts } from "../src/ir/eval-literal.js";
import { preparedBindingRewritten } from "../src/ir/module-binding-script-var.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { ts } from "../src/ts-api.js";

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

const NO_PROVIDER = "ir/from-ast: eval statement has no eval provider in <module-init>";
const CALLED = "ir/from-ast: eval literal has a called source; its call needs the %eval% identity test (#7363 A4)";
/** A qualifying site of `text` that is never lowered. */
const deadSite = (text: string) => `do { break; eval(${JSON.stringify(text)}); } while (false);`;

type Result = Awaited<ReturnType<typeof compile>>;
const errorsOf = (result: Result) =>
  result.errors.filter((error) => error.severity === "error").map((error) => error.message);
/** Without abort bodies, as the A2 tests ask. */
const gaps = async (source: string, settings: Test262CompileOptions = options) =>
  errorsOf(await compile(source, settings, undefined, "refuse"));

/** Compile, run startup, and report the program's sources. */
async function sourcesOf(source: string, settings: Test262CompileOptions = options) {
  const result = await compile(source, settings, undefined, "refuse");
  expect(errorsOf(result)).toEqual([]);
  (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
  return requiredPreparedEmission(result)!.units.sources.map((row) => row.file);
}

describe("#7363 RV7432 B1 — a text the compile's gates refuse joins no program", () => {
  const rows = [
    // The review's five rows: each compiles on main.
    ["a duplicate label", deadSite("l: l: 1")],
    ["await in a Script", deadSite("await 1")],
    ["a string stored into a number var", `var x = 1;\n${deadSite("x = 's'")}\nx + 1;`],
    ["a number stored into a function var", `var g = function () { return 1; };\n${deadSite("g = 2")}\ng();`],
    ["a store into a declared function", `function f() { return 1; }\nvar v = f;\n${deadSite("f = 2")}\nv();`],
    // A JavaScript file's syntax error that the eval parse does not report.
    ["TypeScript-only syntax", deadSite("enum E {}")],
    ["one reported text among two", 'do { break; eval("l: l: 1"); eval("2"); } while (false);'],
  ] as const;
  it.each(SETTINGS.flatMap(([setting, settings]) => rows.map(([label, source]) => [label, setting, source, settings])))(
    "%s (%s): compiles as on main, without an eval source",
    async (_label, _setting, source, settings) => {
      expect(await sourcesOf(source, settings)).toEqual(["test.js"]);
    },
  );

  it.each(SETTINGS)("a reached site keeps main's refusal (%s)", async (_setting, settings) => {
    expect(await gaps('try { eval("l: l: 1"); } catch (e) {}', settings)).toEqual([NO_PROVIDER]);
    expect(await gaps('eval("/(?<a>.)\\\\k<b>/");', settings)).toEqual([NO_PROVIDER]);
    // A malformed text is no site at all.
    expect(await gaps('eval("1 +");', settings)).toEqual([NO_PROVIDER]);
  });

  // A diagnostic no gate refuses is tolerated in a text as in an entry: the text joins, and the site is claimed.
  it.each(SETTINGS)("a text that reads an undeclared global joins (%s)", async (_setting, settings) => {
    expect(await gaps('eval("undeclaredX");', settings)).toEqual([`${CALLED} in <module-init>`]);
  });

  // TypeScript reports these only as semantic diagnostics, which no gate refuses; the site predicate does.
  it("an await outside every async function of the text is no site", () => {
    for (const text of ["await 1", "(function () { await 1; })", "(function () { return await 1; })"])
      expect(literalEvalTexts("test.js", `eval(${JSON.stringify(text)});`)).toEqual([]);
    expect(literalEvalTexts("test.js", 'eval("(async function () { await 1; })");')).toHaveLength(1);
  });

  // A member store in the text declares a JS expando property of the caller's `o`, which makes `n = o.p` a type error
  // of the entry: no diagnostic lands in the text. Without semantic diagnostics nothing is reported, so the text joins.
  it("a text that adds a diagnostic to the entry joins no program", async () => {
    const source = `var o = {};\nvar n = 1;\n${deadSite("o.p = 's'")}\nn = o.p;`;
    expect(await sourcesOf(source)).toEqual(["test.js"]);
    expect(await sourcesOf(source, SETTINGS[1][1])).toEqual(["test.js", literalEvalFileName(0)]);
  });

  // TS2345 is a hard type error: it fails an entry, so it keeps the text out.
  it("a text with a hard type error joins no program", async () => {
    expect(await sourcesOf(deadSite("parseInt(1)"))).toEqual(["test.js"]);
  });

  it("an entry's own diagnostics stay main's", async () => {
    expect(await gaps(`var y = 1;\ny = "s";\n${deadSite("1")}`)).toEqual([
      "Type 'string' is not assignable to type 'number'.",
    ]);
  });

  // `o.p` is TS2339 in the entry, which the compile tolerates: the text changes nothing, so it joins.
  it.each(SETTINGS)("a text joins beside an entry diagnostic it does not change (%s)", async (_setting, settings) => {
    expect(await sourcesOf(`var o = function () {};\no.p;\n${deadSite("1")}`, settings)).toEqual([
      "test.js",
      literalEvalFileName(0),
    ]);
  });
});

describe("#7363 RV7432 B2 — a text that stores into an identifier is no site", () => {
  it.each([
    "x = 1",
    "x += 1",
    "x++",
    "--x",
    "x ||= 1",
    "[x] = [1]",
    "({ x } = { x: 1 })",
    "for (x in {}) ;",
    // The text's own parameter too: no scope walk tells it from a caller binding.
    "(function (p) { p = 1; })(0)",
  ])("%s", (text) => {
    expect(literalEvalTexts("test.js", `var x;\neval(${JSON.stringify(text)});`)).toEqual([]);
  });

  it("keeps a text that reads a binding or stores into a property", () => {
    expect(literalEvalTexts("test.js", 'var o = {};\neval("o.p = o.q");')).toEqual(["o.p = o.q"]);
  });

  // The proofs see only the declaring file's writes: with the text as a script, `g` reads as never rewritten.
  it("the write it refuses is one the binding proofs do not see", () => {
    const ast = analyzeMultiSource(
      { "test.js": "var g = function () {};", [literalEvalFileName(0)]: "g = 2;" },
      "test.js",
      undefined,
      { allowJs: true },
    );
    const [statement] = ast.entryFile.statements as unknown as [ts.VariableStatement];
    const name = statement.declarationList.declarations[0]!.name as ts.Identifier;
    expect(preparedBindingRewritten(ast.checker, name)).toBe(false);
  });

  // A4's shape: once the call runs, a static direct call of `g` would miss the text's rewrite.
  it("refuses the site of a text that rewrites a static function value, as main does", async () => {
    const write = 'eval("g = function () { return 2; }");';
    expect(await gaps(`var g = function () { return 1; };\n${write}\ng();`)).toEqual([NO_PROVIDER]);
    const dead = `var g = function () { return 1; };\ndo { break; ${write} } while (false);\nif (g() !== 1) throw 1;`;
    expect(await sourcesOf(dead)).toEqual(["test.js"]);
  });
});
