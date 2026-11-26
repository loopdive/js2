// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7363 slice A, A2 — a top-level literal direct eval becomes a called script source of the program. The Prepared
// entry adds each qualifying site's text as `<eval:N>.js`, pairs the site with that script, the receipt checks the
// pair, and the script's module init is "called": startup does not run it; since A4 the site calls it. A site after
// `break` is never lowered, so its program compiles and shows the source.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import {
  literalEvalFileName,
  literalEvalTexts,
  pairLiteralEvalSources,
  verifyLiteralEvalSources,
  type LiteralEvalSource,
} from "../src/ir/eval-literal.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import {
  compile,
  compileMulti,
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

const EVAL_LITERAL = "ir/from-ast: eval literal:";
const NO_PROVIDER = "ir/from-ast: eval statement has no eval provider";
const DIRECT_CALL = 'ir/from-ast: direct call to "eval" has no exact AST-site plan';
/** A qualifying site that is never lowered: the program compiles. */
const DEAD_SITE = 'do { break; eval("throw 1;"); } while (false);';

const errorsOf = (result: Awaited<ReturnType<typeof compile>>) =>
  result.errors.filter((error) => error.severity === "error").map((error) => error.message);
/** (#7354 U) Without abort bodies, under which an eval refused inside a function becomes that function's abort body. */
const gaps = async (source: string, overrides: Partial<Test262CompileOptions> = {}) =>
  errorsOf(await compile(source, { ...options, ...overrides } as Test262CompileOptions, undefined, "refuse"));

/** Run a compiled program's startup; report its sources and whether startup threw. */
function run(result: Awaited<ReturnType<typeof compile>>) {
  expect(errorsOf(result)).toEqual([]);
  const sources = requiredPreparedEmission(result)!.units.sources.map((row) => row.file);
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return { sources, startup: "returned" };
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return { sources, startup: "threw" };
  }
}

describe("#7363 A2 — a qualifying site adds a called source and refuses by name", () => {
  it("adds one source per site, in source order", () => {
    expect(literalEvalTexts("test.js", 'eval("1");\nif (c) eval(`2`);')).toEqual(["1", "2"]);
  });

  // (A4) A statement site, or one whose value is discarded, is a call of its source; a site whose completion value is
  // used refuses by A5's name.
  it("lowers a statement site and refuses an expression-position site by A5's name", async () => {
    expect(await gaps('eval("1");')).toEqual([]);
    expect(await gaps('void eval("1");')).toEqual([]);
    expect(literalEvalTexts("test.js", 'var v = eval("1");')).toEqual(["1"]);
    expect(await gaps('var v = eval("1");')).toEqual([
      `${EVAL_LITERAL} its completion value needs #7363 A5 in <module-init>`,
    ]);
  });

  it("compiles the called source, and startup does not run it", async () => {
    expect(run(await compile(DEAD_SITE, options))).toEqual({
      sources: ["test.js", literalEvalFileName(0)],
      startup: "returned",
    });
  });

  it("runs the same text at startup when it is an ordinary script", async () => {
    const result = await compileMulti({ "called.js": "throw 1;", "test.js": DEAD_SITE }, "test.js", options);
    expect(run(result)).toEqual({ sources: ["test.js", literalEvalFileName(0), "called.js"], startup: "threw" });
  });

  it("leaves a program with no qualifying site with its one source", async () => {
    expect(literalEvalTexts("test.js", "var x = 1;")).toEqual([]);
    expect(run(await compile("if (1 + 1 !== 2) throw 1;", options))).toEqual({
      sources: ["test.js"],
      startup: "returned",
    });
  });

  it("adds no source without allowJs, since an eval source is a JavaScript root (RV7432 B1)", async () => {
    const ts = { allowJs: false, fileName: "test.ts" };
    expect(await gaps('eval("1");', ts)).toEqual([`${NO_PROVIDER} in <module-init>`]);
    expect(await gaps(DEAD_SITE, ts)).toEqual([]);
  });

  it("refuses a supplied file that takes an eval source's name", async () => {
    await expect(
      compileMulti({ "test.js": 'eval("1");', [literalEvalFileName(0)]: "1" }, "test.js", options),
    ).rejects.toThrow(/reserved for a literal eval source/);
  });
});

describe("#7363 A2 — an excluded site adds no source and keeps its slice-1 refusal", () => {
  it.each([
    ["inside catch (e)", 'try { throw 1; } catch (e) { eval("1"); }', NO_PROVIDER],
    ["inside a block with let", '{ let y = 1; eval("1"); }', NO_PROVIDER],
    ["inside a loop with a let head", 'for (let i = 0; i < 1; i++) eval("1");', NO_PROVIDER],
    ["inside a function", 'function f() { eval("1"); }\nf();', `${NO_PROVIDER} in f`],
    ["in a strict file", '"use strict";\neval("1");', NO_PROVIDER],
    ["a text that declares a var", 'eval("var x = 1");', NO_PROVIDER],
    ["a text that declares a function", 'eval("function g() {}");', NO_PROVIDER],
    ["a text that declares a let", 'eval("let x = 1");', NO_PROVIDER],
    ["a text with a var in a nested function", 'eval("(function () { var x; })");', NO_PROVIDER],
    ["a text with a nested eval", "eval(\"eval('1')\");", NO_PROVIDER],
    ["a static SyntaxError text", 'eval("break;");', NO_PROVIDER],
    ["a parse failure", 'eval("1 +");', NO_PROVIDER],
    // language/eval-code/direct/parse-failure-5.js
    ["a top-level return", 'eval("return;");', NO_PROVIDER],
    ["a return in a class static block", 'eval("(class { static { return; } })");', NO_PROVIDER],
    ["a text with export", 'eval("export default 1;");', NO_PROVIDER],
    ["a text with import.meta", 'eval("import.meta;");', NO_PROVIDER],
    // One more statement than a module-init chunk holds: the called init would lower as several functions.
    ["a text that lowers in two chunks", `eval(${JSON.stringify("1;".repeat(17))});`, NO_PROVIDER],
    ["a call with two arguments", 'eval("1", 2);', DIRECT_CALL],
  ])("%s", async (_label, source, gap) => {
    expect(literalEvalTexts("test.js", source)).toEqual([]);
    expect(await gaps(source)).toEqual([gap.includes(" in ") ? gap : `${gap} in <module-init>`]);
  });

  // These stop at an earlier gap of their own; what matters is that the site adds no source.
  it.each([
    ["inside with", 'with ({}) { eval("1"); }'],
    ["inside a block with a function declaration", '{ function g() {} eval("1"); }'],
    ["inside a switch with a let", 'switch (1) { case 1: let y; eval("1"); }'],
    ["inside a class", 'class C { static m() { eval("1"); } }'],
    ["inside a class field initializer", 'class C { static f = eval("1"); }'],
    ["inside a block with a class", '{ class K {} eval("1"); }'],
    ["inside a for-in with a let head", 'for (let k in {}) eval("1");'],
    ["in a module", 'export {};\neval("1");'],
    ["an optional call", 'eval?.("1");'],
    ["a computed source", 'var s = "1";\neval(s);'],
    ["a parenthesized callee", '(eval)("1");'],
    ["a text that declares a class", 'eval("class K {}");'],
    ["a text that declares a block function", 'eval("{ function g() {} }");'],
    ["another callee", 'evaluate("1");'],
    ["a string-literal callee spelled eval", '"eval"("1");'],
  ])("%s", async (_label, source) => {
    expect(literalEvalTexts("test.js", source)).toEqual([]);
    expect((await gaps(source)).some((message) => message.startsWith(EVAL_LITERAL))).toBe(false);
  });

  it("keeps the text of a return inside a function of the text", () => {
    expect(literalEvalTexts("test.js", 'eval("(function () { return; })");')).toEqual(["(function () { return; })"]);
  });

  it("keeps a text of exactly one chunk", () => {
    expect(literalEvalTexts("test.js", `eval(${JSON.stringify("1;".repeat(16))});`)).toHaveLength(1);
  });

  it("adds no source in a module-goal compile", async () => {
    expect(await gaps('eval("1");', { inferModuleStrictArguments: true })).toEqual([`${NO_PROVIDER} in <module-init>`]);
  });

  it("does not take a shadowed eval for the global one", () => {
    expect(literalEvalTexts("test.js", 'var eval;\neval("1");')).toEqual([]);
  });
});

describe("#7363 A2 — the receipt", () => {
  /** A real relation, analyzed as the Prepared entry analyzes it. */
  const program = (entry: string, extra: Record<string, string> = {}) => {
    const texts = literalEvalTexts("test.js", entry);
    const files: Record<string, string> = { "test.js": entry, ...extra };
    texts.forEach((text, index) => (files[literalEvalFileName(index)] = text));
    const ast = analyzeMultiSource(files, "test.js", undefined, { allowJs: true });
    const rows = pairLiteralEvalSources(ast.entryFile, ast.sourceFiles, texts.length);
    const byName = (name: string) => ast.sourceFiles.find((source) => source.fileName === name)!;
    return { ast, rows, byName };
  };
  const verify = (rows: readonly LiteralEvalSource[], ast: ReturnType<typeof analyzeMultiSource>) => () =>
    verifyLiteralEvalSources(rows, ast.sourceFiles, ast.entryFile);

  it("accepts the real relation and returns its calls and sources", () => {
    const { ast, rows } = program('eval("1");\neval("2");');
    expect(rows.map((row) => row.source.text)).toEqual(["1", "2"]);
    const related = verify(rows, ast)();
    expect([...related.calls]).toEqual(rows.map((row) => [row.call, row.source]));
    expect([...related.sources]).toEqual(rows.map((row) => row.source));
  });

  it("refuses a source whose text is not the literal's value", () => {
    const { ast, rows } = program('eval("1");\neval("2");');
    expect(verify([{ call: rows[1]!.call, source: rows[0]!.source }], ast)).toThrow(PreparedIrProgramInvariantError);
    expect(verify([{ call: rows[1]!.call, source: rows[0]!.source }], ast)).toThrow(
      /the source text is not the literal's value/,
    );
  });

  it("refuses two rows for one source, and two rows for one call", () => {
    const { ast, rows } = program('eval("1");\neval("1");');
    expect(verify([rows[0]!, { call: rows[1]!.call, source: rows[0]!.source }], ast)).toThrow(/occurs in two rows/);
    expect(verify([rows[0]!, { call: rows[0]!.call, source: rows[1]!.source }], ast)).toThrow(/occurs in two rows/);
  });

  it("refuses a call that is not in the entry", () => {
    const { ast, rows, byName } = program('eval("1");', { "other.js": 'eval("1");' });
    expect(verify([{ call: callsOf(byName("other.js"))[0]!, source: rows[0]!.source }], ast)).toThrow(
      /the call is not in the entry/,
    );
  });

  it("refuses a call that does not qualify", () => {
    const { ast, rows } = program('eval("1");\nfunction f() { eval("1"); }');
    expect(verify([{ call: callsOf(ast.entryFile)[1]!, source: rows[0]!.source }], ast)).toThrow(
      /the call is not a qualifying site/,
    );
  });

  it("refuses a source that is not a script of the program", () => {
    const { ast, rows, byName } = program('eval("1");', { "other.js": "1", "module.js": "export {};" });
    const foreign = analyzeMultiSource({ "x.js": "1" }, "x.js", undefined, { allowJs: true }).entryFile;
    for (const source of [ast.entryFile, foreign, byName("module.js")])
      expect(verify([{ call: rows[0]!.call, source }], ast)).toThrow(/not a script of the program/);
    // Any script of the program with the literal's text will do: the relation, not the name, makes it called.
    expect(verify([{ call: rows[0]!.call, source: byName("other.js") }], ast)).not.toThrow();
  });

  it("refuses a pairing that misses a script the entry's texts became", () => {
    const { ast } = program('eval("1");');
    expect(() => pairLiteralEvalSources(ast.entryFile, ast.sourceFiles, 2)).toThrow(PreparedIrProgramInvariantError);
    const unpaired = analyzeMultiSource({ "test.js": 'eval("1");' }, "test.js", undefined, { allowJs: true });
    expect(() => pairLiteralEvalSources(unpaired.entryFile, unpaired.sourceFiles, 1)).toThrow(
      /<eval:0>.js is not a script of the analyzed program/,
    );
  });
});

/** The file's calls, in source order. */
function callsOf(file: ts.SourceFile): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}
