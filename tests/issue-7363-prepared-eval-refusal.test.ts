// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7363 slice 1 — an eval statement on the Prepared path refused with an invariant error ("certified global eval lost
// an owning predicate"), which crashed compile() on 195 ES5 files. The Prepared resolver has no eval provider, so an
// eval statement now refuses by name, unless its `eval` resolves to a binding the source declares in an enclosing
// scope (`resolvesToSourceBinding`): that one is an ordinary call. Whether the global binding still holds the
// realm's eval is a run-time question, which slice 2 asks. The ordinary pipeline keeps its invariant.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { resolvesToSourceBinding } from "../src/ir/analysis/ast-scope.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import { agreesWithNode } from "./helpers/prepared-node-agreement.js";

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

const INVARIANT = "certified global eval lost an owning predicate";
const refusal = (owner: string) => `ir/from-ast: eval statement has no eval provider in ${owner}`;
const ordinaryCall = (owner: string) => `ir/from-ast: direct call to "eval" has no exact AST-site plan in ${owner}`;
// (#7354 F2) A call through the catch binding: no function value in the program, so always the TypeError.
const DYNAMIC_CALL =
  "dynamic operation js.closure.call:1 in a program that creates no function value has no Prepared intrinsic";
const PATTERN = "whole-program binding pattern requires the existing destructuring producer";

/**
 * The compile's refusals. The checker's remarks on a binding named `eval` are warnings and are left out. (#7354 U)
 * Without abort bodies, under which an eval refused inside a function becomes that function's abort body.
 */
const gaps = async (source: string) =>
  (await compile(source, options, undefined, "refuse")).errors
    .filter((error) => error.severity === "error")
    .map((error) => error.message);

describe("#7363 slice 1 — an eval statement on the Prepared path refuses by name", () => {
  // A top-level literal that declares nothing is a called source since #7363 A2, and A4 lowers it while the global
  // `eval` is pristine; a rebound `eval` refuses it with A4's own label.
  it("lowers a literal at top level as a site with a called source", async () => {
    expect(await gaps('eval("1");')).toEqual([]);
    expect(await gaps('eval("1");\neval = 0;')).toEqual([
      "ir/from-ast: eval literal: the global eval is not pristine (#7363 A4) in <module-init>",
    ]);
  });

  // The rebinding rows call from a function: a top-level site would add a source, and then a script `var` has no
  // home until #7363 A3, so the compile would stop at the `var` first.
  it.each([
    ["a declaration in a function", 'function f() { eval("var y = 1"); }\nf();', "f"],
    ["an alias of the global", 'function f() { eval("1"); }\nvar e = eval;', "f"],
    ["an eval property", 'function f() { eval("1"); }\nvar o = {};\no.eval = 1;', "f"],
    ["the name as a string", 'function f() { eval("1"); }\nvar key = "eval";', "f"],
    ["a computed source", 'var s = "1";\neval(s);', "<module-init>"],
    ["the indirect (0, eval) spelling", '(0, eval)("1");', "<module-init>"],
    // Not lexical: what the global binding holds when the call runs is slice 2's question.
    ["a write through globalThis", 'function f() { eval("1"); }\nglobalThis.eval = function (x) { return x; };', "f"],
    // (#7354 C2) "a write through this" (`this.eval = …` beside `f()`) now refuses first at the receiverless direct
    // call of f, which reads `this` through the eval.
    // A binding in a scope that does not enclose the call.
    ["another function's parameter", 'function f() { eval("1"); }\nfunction g(eval) { return eval; }', "f"],
    ["another function's inner function", 'function f() { eval("1"); }\nfunction g() { function eval() {} }', "f"],
    ["a sibling block's let", 'function f() { eval("1"); }\n{ let eval = 1; }', "f"],
    ["a catch binding outside its clause", 'function f() { eval("1"); }\ntry { throw 1; } catch (eval) {}', "f"],
    ["a function expression's name outside it", 'function f() { eval("1"); }\n(function eval() {});', "f"],
  ])("refuses %s", async (_label, source, owner) => {
    expect(await gaps(source)).toEqual([refusal(owner)]);
  });

  // Each `eval` here resolves to a source binding, so it is an ordinary callee and the compile stops at its own first
  // gap. Where that gap is the declaration itself, the call is never lowered: the walk test below pins those forms.
  it.each([
    ["a hoisted top-level var", 'eval("1");\nvar eval = function (v) { return v; };', ordinaryCall("<module-init>")],
    ["a top-level var without a value", 'var eval;\neval("1");', ordinaryCall("<module-init>")],
    ["a var hoisted out of a block", 'eval("1");\nif (true) { var eval = 1; }', ordinaryCall("<module-init>")],
    ["a top-level var seen from a function", 'function f() { eval("1"); }\nvar eval;', ordinaryCall("f")],
    ["an object pattern var", 'eval("1");\nvar { eval } = { eval: 1 };', PATTERN],
    ["an array pattern var", 'eval("1");\nvar [eval] = [1];', PATTERN],
    ["a hoisted top-level function", 'eval("1");\nfunction eval(v) { return v; }', ordinaryCall("<module-init>")],
    ["a hoisted local function", 'function f() { eval("1"); function eval(v) { return v; } }', ordinaryCall("f")],
    ["a hoisted local var", 'function f() { eval("1"); var eval = 1; }', ordinaryCall("f")],
    ["a block function, for its function", 'function f() { eval("1"); { function eval() {} } }', ordinaryCall("f")],
    ["a block function, for its file", 'function f() { eval("1"); }\n{ function eval() {} }', ordinaryCall("f")],
    ["a parameter", 'function f(eval) { eval("1"); }\nf(1);', DYNAMIC_CALL],
    [
      "a destructured parameter",
      'function f({ eval }) { eval("1"); }\nf({ eval: 1 });',
      "ir/from-ast: object destructuring source must be IrType.object or IrType.class (got dynamic) in f",
    ],
    [
      "a default-valued parameter",
      'function f(eval = 1) { eval("1"); }\nf();',
      "ir/from-ast: rest/default/optional param not in Phase 1 IR scope (f)",
    ],
    ["a catch binding", 'try { throw 1; } catch (eval) { eval("1"); }', DYNAMIC_CALL],
    [
      "a destructured catch binding",
      'try { throw 1; } catch ({ eval }) { eval("1"); }',
      "ir/from-ast: destructuring catch param not in slice 9 (<module-init>)",
    ],
    ["a block let", '{ let eval = 1; eval("1"); }', ordinaryCall("<module-init>")],
    ["a block const", '{ const eval = 1; eval("1"); }', ordinaryCall("<module-init>")],
    ["a loop head let", 'function f() { for (let eval = 0; eval < 1; eval++) { eval("1"); } }', ordinaryCall("f")],
    ["a switch let", 'function f() { switch (1) { case 1: let eval = 1; default: eval("1"); } }', ordinaryCall("f")],
  ])("does not take %s for the global eval", async (_label, source, gap) => {
    expect(await gaps(source)).toEqual([gap]);
  });

  // (#7354 T) The IIFE used to refuse as a call through a value; now it runs, and `eval` is the expression itself.
  it("does not take a named function expression for the global eval", async () => {
    await agreesWithNode("var d = 0;\n(function eval(x) { d = d + x; if (d < 3) eval(1); })(1);\nvar out = 'd' + d;");
  });

  // `class eval` is a SyntaxError (class code is strict), which the front end reports before any lowering.
  it("stops a class named eval at its early error", async () => {
    expect(await gaps('{ class eval {} eval("1"); }')).toEqual([
      "Value of type 'typeof eval' is not callable. Did you mean to include 'new'?",
      "Binding 'eval' in strict mode is not allowed",
    ]);
  });
});

describe("#7363 slice 1 — resolvesToSourceBinding, the lexical question", () => {
  /** The answer for the callee of the source's `eval("1")` call. */
  const resolves = (source: string): boolean => {
    const file = ts.createSourceFile("test.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let callee: ts.Identifier | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "eval")
        callee = node.expression;
      ts.forEachChild(node, visit);
    };
    visit(file);
    return resolvesToSourceBinding(callee!);
  };

  it.each([
    ["var", 'var eval; eval("1");'],
    ["a hoisted var", 'eval("1"); var eval = 1;'],
    ["a var hoisted out of a block", 'eval("1"); if (c) { var eval; }'],
    ["a var hoisted out of a loop head", 'eval("1"); for (var eval in o) {}'],
    ["a top-level let", 'let eval; eval("1");'],
    ["a let object pattern", 'let { a: { eval } } = o; eval("1");'],
    ["a let array pattern", 'let [, ...eval] = a; eval("1");'],
    ["a hoisted function", 'eval("1"); function eval() {}'],
    ["a hoisted local function", 'function f() { eval("1"); function eval() {} }'],
    ["a local var", 'function f() { eval("1"); var eval; }'],
    ["an enclosing function's var", 'function f() { var g = function () { eval("1"); }; var eval; }'],
    ["a block function, in its block", '{ function eval() {} eval("1"); }'],
    ["a block function, for its function", 'function f() { eval("1"); { function eval() {} } }'],
    ["a block function, for its file", 'eval("1"); { function eval() {} }'],
    ["a parameter", 'function f(eval) { eval("1"); }'],
    ["an object pattern parameter", 'function f({ eval }) { eval("1"); }'],
    ["an array pattern parameter", 'function f([eval]) { eval("1"); }'],
    ["a default-valued parameter", 'function f(eval = 1) { eval("1"); }'],
    ["an arrow parameter", '(eval) => { eval("1"); };'],
    ["a method parameter", '({ m(eval) { eval("1"); } });'],
    ["a catch binding", 'try {} catch (eval) { eval("1"); }'],
    ["an object pattern catch", 'try {} catch ({ eval }) { eval("1"); }'],
    ["an array pattern catch", 'try {} catch ([eval]) { eval("1"); }'],
    ["a block let", '{ let eval; eval("1"); }'],
    ["a block const", '{ const eval = 1; eval("1"); }'],
    ["a block class", '{ class eval {} eval("1"); }'],
    ["a switch let, from another clause", 'switch (x) { case 1: let eval; default: eval("1"); }'],
    ["a for head let", 'for (let eval = 0; ; ) { eval("1"); }'],
    ["a for-in head let", 'for (let eval in o) { eval("1"); }'],
    ["a for-of head const", 'for (const eval of a) { eval("1"); }'],
    ["a function expression's own name", '(function eval() { eval("1"); });'],
    ["a class expression's own name", '(class eval { m() { eval("1"); } });'],
    ["a default import", 'import eval from "m"; eval("1");'],
    ["a namespace import", 'import * as eval from "m"; eval("1");'],
    ["a named import", 'import { eval } from "m"; eval("1");'],
    ["a renamed import", 'import { x as eval } from "m"; eval("1");'],
  ])("yes for %s", (_label, source) => {
    expect(resolves(source)).toBe(true);
  });

  it.each([
    ["no declaration", 'eval("1");'],
    ["another function's parameter", 'function g(eval) {} eval("1");'],
    ["another function's var", 'function g() { var eval; } eval("1");'],
    ["another function's inner function", 'function g() { function eval() {} } eval("1");'],
    ["another function's block function", 'function g() { { function eval() {} } } eval("1");'],
    ["a sibling block's let", '{ let eval; } eval("1");'],
    ["a sibling block's class", '{ class eval {} } eval("1");'],
    ["a catch binding, after its clause", 'try {} catch (eval) {} eval("1");'],
    ["a catch binding, in its try block", 'try { eval("1"); } catch (eval) {}'],
    ["a for head let, after the loop", 'for (let eval = 0; ; ) {} eval("1");'],
    ["a switch let, after the switch", 'switch (x) { case 1: let eval; } eval("1");'],
    ["a function expression's name, outside it", '(function eval() {}); eval("1");'],
    ["a class expression's name, outside it", '(class eval {}); eval("1");'],
    ["an import's exported name", 'import { eval as x } from "m"; eval("1");'],
    ["a property", 'var o = { eval: 1 }; o.eval = 2; eval("1");'],
    ["a method", 'class C { eval() {} m() { eval("1"); } }'],
    ["a label", 'eval: for (;;) { eval("1"); break eval; }'],
    ["a write through globalThis", 'globalThis.eval = f; eval("1");'],
    ["a write through this", 'this.eval = f; eval("1");'],
  ])("no for %s", (_label, source) => {
    expect(resolves(source)).toBe(false);
  });
});

describe("#7363 slice 1 — the ordinary pipeline keeps the certified-eval invariant", () => {
  // The selector certifies a global eval statement before from-ast lowers it; a provider-bearing resolver that then
  // disagrees about the binding is a selection/preparation mismatch, never a silent demotion.
  it("throws the invariant when the provider's resolver does not see the ambient eval", () => {
    const analysis = analyzeSource('export function f(): void { eval("1"); }');
    const declaration = analysis.sourceFile.statements.find(ts.isFunctionDeclaration)!;
    expect(() =>
      lowerFunctionAstToIr(declaration, {
        ownerUnitId: createTestIrFunctionIdentityFactory("issue-7363").next("f").unitId,
        checker: analysis.checker,
        resolver: { globalEvalTarget: () => irRuntimeFuncRef("__eval_provider"), isAmbientBinding: () => false },
      }),
    ).toThrow(INVARIANT);
  });
});
