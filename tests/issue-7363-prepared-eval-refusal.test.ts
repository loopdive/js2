// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7363 slice 1 — an eval statement on the Prepared path refused with an invariant error ("certified global eval lost
// an owning predicate"), which crashed compile() on 195 ES5 files. The Prepared resolver proves which `eval` is the
// realm's (`prepareRealmEvalResolver`) and has no eval provider, so such a statement now refuses by name. An `eval`
// that is shadowed or rebound anywhere never reaches that refusal. The ordinary pipeline keeps its invariant.
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

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
const INVARIANT = "certified global eval lost an owning predicate";
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

  // Each `eval` here is not provably the realm's, so it is an ordinary callee and stops at that call's own gap. A
  // rebinding that follows the call still refuses the whole-program proof (any `globalThis` use can reach the binding).
  it.each([
    [
      "a hoisted top-level var",
      'eval("1");\nvar eval = function (v) { return v; };',
      'direct call to "eval" has no exact AST-site plan',
    ],
    [
      "a hoisted top-level function",
      'eval("1");\nfunction eval(v) { return v; }',
      'direct call to "eval" has no exact AST-site plan',
    ],
    [
      "a hoisted local var",
      'function f() { eval("1"); var eval = function (v) { return v; }; }\nf();',
      'direct call to "eval" has no exact AST-site plan',
    ],
    [
      "a parameter",
      'function f(eval) { eval("1"); }\nf(function (v) { return v; });',
      "dynamic operation __ir_dyn_call_argument has no Prepared intrinsic",
    ],
    [
      "a catch binding",
      'try { throw 1; } catch (eval) { eval("1"); }',
      "dynamic operation __ir_dyn_call_argument has no Prepared intrinsic",
    ],
    [
      "a block binding",
      '{ let eval = function (v) { return v; }; eval("1"); }',
      "closure params must have annotations",
    ],
    ["a later alias", 'eval("1");\nvar e = eval;', ""],
    ["a later globalThis use", 'eval("1");\nglobalThis.x = 1;', ""],
    ["a later property write", 'eval("1");\nvar o = {};\no.eval = 1;', ""],
    ["the name as a later string key", 'eval("1");\nvar key = "eval";', ""],
  ])("does not take %s for the realm's eval", async (_label, source, gap) => {
    const errors = (await messages(source)).join("\n");
    expect(errors).toContain(gap);
    expect(errors).not.toContain(REFUSAL);
    expect(errors).not.toContain(INVARIANT);
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
