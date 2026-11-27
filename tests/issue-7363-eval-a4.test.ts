// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7363 A4 (narrowed) — a top-level literal direct eval in statement position is a direct call of its called script's
// init, with no run-time %eval% identity test: the global `eval` is the realm's at every site when no source rebinds
// it (`pristineBuiltinGlobal`) and no sloppy function lets its ambient `this`, the global object, escape
// (`ambientThisMayBeGlobal`). Otherwise the site refuses at select by A4's name. A failure of the compile with the
// texts falls back to the compile without them. Every row goes through the Prepared entry with the census's options
// (scripts/ir-census/prepared-census.mts).
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { compile, requiredPreparedEmission, requiredPreparedFailure } from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { literalEvalTexts } from "../src/ir/eval-literal.js";
import { hasHtmlLikeComment } from "../src/frontend/eval/script.js";

// Counts the entry's program compiles; every call passes through.
const presentations = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/compiler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/compiler.js")>();
  return {
    ...actual,
    runPreparedIrPipelinePresentation: (...args: Parameters<typeof actual.runPreparedIrPipelinePresentation>) => {
      presentations.count++;
      return actual.runPreparedIrPipelinePresentation(...args);
    },
  };
});

const options = {
  wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
  allowJs: true,
  fileName: "test.js",
  sourceMap: false,
  emitWat: false,
  skipSemanticDiagnostics: true,
  target: "standalone",
  inferModuleStrictArguments: false,
  scriptGoal: true,
  deferTopLevelInit: true,
  hostBridge: "always",
  trackIrOutcomes: true,
} as const;

const NOT_PRISTINE = "ir/from-ast: eval literal: the global eval is not pristine (#7363 A4) in <module-init>";
const A5 = "ir/from-ast: eval literal: its completion value needs #7363 A5 in <module-init>";

type Result = Awaited<ReturnType<typeof compile>>;
const compiled = (source: string) => compile(source, options as never);
const gaps = async (source: string) =>
  (await compiled(source)).errors.filter((error) => error.severity === "error").map((error) => error.message);

/** How the program's startup ended. */
function run(result: Result): "returned" | "threw" {
  expect(result.errors.filter((error) => error.severity === "error")).toEqual([]);
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as () => void)();
    return "returned";
  } catch (error) {
    expect(error).toBeInstanceOf(WebAssembly.Exception);
    return "threw";
  }
}

/** How node's run of the source as a sloppy script ended. */
function node(source: string): "returned" | "threw" {
  try {
    runInNewContext(source);
    return "returned";
  } catch {
    return "threw";
  }
}

describe("#7363 A4 — a write of the global eval anywhere refuses the site by name", () => {
  // A top-level `var eval` or `function eval(){}` binds the call's `eval` in the source, so it is no site at all
  // (slice 1's rows); nested, the binding is still "a binding named eval at any level".
  it.each([
    ["an assignment", "eval = f;"],
    ["a compound assignment", 'eval += "";'],
    ["a destructuring target", "[eval] = [f];"],
    ["a var", "function g() { var eval; }"],
    ["a function declaration", "function g() { function eval() {} }"],
    ["a member write through globalThis", "globalThis.eval = f;"],
    ["a member write through this", "this.eval = f;"],
    ["delete", "delete eval;"],
  ])("%s", async (_label, write) => {
    expect(await gaps(`var f = 0;\neval("1");\n${write}`)).toEqual([NOT_PRISTINE]);
  });

  it("lowers the site when nothing writes eval", async () => {
    expect(run(await compiled('var f = 0;\neval("1");'))).toBe("returned");
  });

  it("refuses a site whose completion value is used by A5's name", async () => {
    expect(await gaps('var v = eval("1");')).toEqual([A5]);
  });
});

describe("#7363 A4, A5 — admission decides a site before lowering (RV7502 2)", () => {
  // `discardsValue`: each form lowers through from-ast's statement position.
  it.each([
    ["an expression statement", 'eval("1");'],
    ["a labelled expression statement", 'L: eval("1");'],
    ["a parenthesized expression statement", '(eval("1"));'],
    ["the operand of void", 'void eval("1");'],
    ["a comma's left operand", 'eval("1"), 0;'],
    ["a parenthesized comma's left operand", '((eval("1")), 0);'],
  ])("lowers %s", async (_label, source) => {
    expect(run(await compiled(source))).toBe("returned");
  });

  // A comma's right operand and a conditional's arm hand their value on; a for incrementor's comma list is lowered
  // clause by clause as values.
  it.each([
    ["a var initializer", 'var v = eval("1");'],
    ["a comma's right operand", '0, eval("1");'],
    ["an argument", 'function f(a) {}\nf(eval("1"));'],
    ["a condition", 'if (eval("1")) {}'],
    ["a conditional's arm", 'var c = 1;\nc ? eval("1") : 0;'],
    ["a clause of a for incrementor", 'for (var i = 0; i < 1; eval("1"), i++) {}'],
  ])("refuses %s by A5's name", async (_label, source) => {
    expect(await gaps(source)).toEqual([A5]);
  });

  it("is a select-time refusal of the program, compiled once", async () => {
    presentations.count = 0;
    const result = await compiled('var f = 0;\neval("1");\neval = f;');
    expect(presentations.count).toBe(1);
    expect(requiredPreparedFailure(result)).toMatchObject({
      kind: "unsupported",
      failure: { code: "literal-eval-site-unsupported", stage: "select", detail: NOT_PRISTINE },
    });
  });

  // Annex B.1.1: TypeScript parses `o.p <!--o.p` as `o.p < !(--o.p)`, so such a text makes no source and its site
  // keeps the refusal it has without one.
  it.each([
    ["an HTML open comment", "o.p <!--o.p"],
    ["an HTML close comment after a line terminator", "x = 1\n--> comment"],
    ["an HTML close comment at the start", "-->x"],
  ])("makes no source of %s", async (_label, text) => {
    const source = `var o = { p: 1 }, x;\neval(${JSON.stringify(text)});`;
    expect(literalEvalTexts("test.js", source)).toEqual([]);
    expect(await gaps(source)).toEqual(["ir/from-ast: eval statement has no eval provider in <module-init>"]);
  });

  // `1 < !--y` holds none; its store into `y` already makes no source, so the member form is the one that does.
  it("holds no HTML comment in `1 < !--y`, and `1 < !--o.p` makes a source", () => {
    expect(hasHtmlLikeComment("1 < !--y")).toBe(false);
    expect(literalEvalTexts("test.js", 'var o = { p: 1 };\neval("1 < !--o.p");')).toEqual(["1 < !--o.p"]);
  });

  it.each(["<!--", "a\r-->", "a\u2028 /* c */ -->", "/*\n*/ -->"])("hasHtmlLikeComment(%j)", (text) => {
    expect(hasHtmlLikeComment(text)).toBe(true);
  });

  it("refuses a site lowering never reaches: admission sees every site", async () => {
    expect(await gaps('var v;\ndo { break; v = eval("1"); } while (false);')).toEqual([A5]);
  });
});

describe("#7363 A4 — a sloppy function whose this escapes refuses the site by name", () => {
  // PRV-A4 B1: `h()` yields the global object, which writes `eval` unseen.
  it("the bare return this", async () => {
    const source = 'function f(){return this} var h = f; var G = h(); G.eval = function(){}; eval("1");';
    expect(await gaps(source)).toEqual([NOT_PRISTINE]);
  });

  it.each([
    ["an alias member", "return this.globalThis;"],
    ["a computed member", 'return this["eval"];'],
    ["a copy", "var t = this;"],
    ["a method call", "return this.valueOf();"],
    ["a constructor member", "return new this.C();"],
    ["a call member's .call", "return this.m.call(null);"],
    ["a tagged template member", "return this.t`x`;"],
    ["a direct eval", 'eval("1");'],
  ])("%s", async (_label, body) => {
    expect(await gaps(`eval("1");\nfunction f() { ${body} }\nvar h = f;`)).toEqual([NOT_PRISTINE]);
  });

  // RV7502 4: no function is a value here, yet a sloppy plain call still gives `f` the global object as `this`.
  it.each([
    ["through a binding", 'function f(){ return this } var G = f(); G.eval = 1; eval("1");'],
    ["directly", 'function f(){ return this } f().eval = 1; eval("1");'],
  ])("a plain call %s", async (_label, source) => {
    expect(await gaps(source)).toEqual([NOT_PRISTINE]);
  });

  it("a parameter initializer", async () => {
    expect(await gaps('eval("1");\nvar h = function (a = this) { return 1; };\nh.x = 1;')).toEqual([NOT_PRISTINE]);
  });

  it.each([
    ["a member read", "return this.x;"],
    ["a member write", "this.x = 1;"],
    ["instanceof", "return this instanceof f;"],
    ["strict code", '"use strict"; return this;'],
  ])("lowers beside %s", async (_label, body) => {
    expect(run(await compiled(`eval("1");\nfunction f() { ${body} }\nvar h = f;`))).toBe("returned");
  });

  it("lowers beside the harness's Test262Error shape", async () => {
    const source = [
      "function E(m) { if (!(this instanceof E)) return new E(m); this.message = m; }",
      "E.prototype.toString = function () { return this.message; };",
      'eval("1");',
    ].join("\n");
    expect(run(await compiled(source))).toBe("returned");
  });
});

describe("#7363 A4 — the proof's boundary (#7503)", () => {
  // The proof sees no write through a global-object value. These refusals keep one from existing; if either label
  // goes away, `pristineBuiltinGlobal` first needs #7503's escape check.
  it("globalThis has no value", async () => {
    expect(await gaps('eval("1");\nglobalThis.x;')).toEqual([
      'ir/from-ast: identifier "globalThis" is not in scope in <module-init>',
    ]);
  });

  it("script-level this has no value", async () => {
    expect(await gaps('eval("1");\nthis.x;')).toEqual([
      "ir/from-ast: 'this' reference outside an instance method body (<module-init>)",
    ]);
  });
});

describe("#7363 A4 — a failure with the texts falls back to the compile without them", () => {
  // The two-argument spelling is no site: its program is the compile without texts.
  it.each([
    ["a text that does not lower, never run", 'var x = 1;\ndo { break; eval("[x]"); } while (false);'],
    ["PRV-A4 B2", 'let y = 1;\ndo { break; eval("y"); } while (false);\nif (y !== 1) throw 1;'],
  ])("%s", async (_label, source) => {
    presentations.count = 0;
    const result = await compiled(source);
    expect(presentations.count).toBe(2);
    const without = await compiled(source.replace(/eval\((".*?")\)/, "eval($1, 0)"));
    expect(requiredPreparedEmission(result)!.units.sources.map((row) => row.file)).toEqual(["test.js"]);
    expect(run(result)).toBe("returned");
    expect(result.binary).toEqual(without.binary);
  });
});

describe("#7363 A4 — a site runs its text", () => {
  // The text reads the entry's var and writes a property of its object; a wrong value throws, in either engine.
  const A3 =
    'var x = 1;\neval("if (x !== 1) throw 2;");\nvar o = { v: 0 };\neval("o.v = x + 1;");\nif (o.v !== 2) throw 3;';

  it.each([
    ["the A3 program", A3],
    ["the A3 program, ending in a text that throws", `${A3}\neval("if (o.v === 2) throw 4;");`],
  ])("agrees with node on %s", async (_label, source) => {
    expect(run(await compiled(source))).toBe(node(source));
  });

  it("is the text that throws", () => {
    expect(node(`${A3}\neval("if (o.v === 2) throw 4;");`)).toBe("threw");
  });

  it("runs its text each time a loop reaches it", async () => {
    const source = 'var o = { c: 0 };\nfor (var i = 0; i < 3; i++) eval("o.c = o.c + 1;");\nif (o.c !== 3) throw o.c;';
    expect(node(source)).toBe("returned");
    expect(run(await compiled(source))).toBe("returned");
  });
});
