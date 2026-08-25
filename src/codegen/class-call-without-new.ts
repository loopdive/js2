// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4483 family E) `C()` on a `class` → TypeError.
 *
 * §10.2.1 [[Call]] step 2: *"If F's [[FunctionKind]] internal slot is
 * classConstructor, throw a TypeError exception."* A class constructor is
 * callable only through `new` / `super`.
 *
 * ## Base behaviour
 *
 * Measured on this branch's base with `runTest262File(…, "standalone")`
 * (`.tmp/probes/p13-class-ctor.js`, one module):
 *
 * | probe                        | base            | spec        |
 * | ---------------------------- | --------------- | ----------- |
 * | `class C {}; C()`            | returns `null`  | TypeError   |
 * | `var D = class {}; D()`      | returns `null`  | TypeError   |
 *
 * `built-ins/Function/internals/Call/class-ctor.js` reads exactly the first
 * row, and a silent `null` is the worst possible answer: the program continues
 * with a value that is neither an instance nor an error.
 *
 * ## Narrowing (absent-not-wrong)
 *
 * - Only a class declared in THIS program's source. An ambient `class` from a
 *   `.d.ts` lib file is how TypeScript models the callable builtins
 *   (`Number(1)`, `String(x)`, `Error(msg)` are all legal CALLS), so a
 *   declaration-file declaration DECLINES — that exclusion is the whole
 *   correctness story of this file.
 * - `super(...)` / `new C()` never reach here (different node kinds), and an
 *   optional call `C?.()` declines with the same reasoning as #4221's guard.
 * - A callee that runtime `eval` may replace declines via
 *   `runtimeEvalMayReplaceCallee`, so a rebound binding keeps its dynamic
 *   IsCallable semantics.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { runtimeEvalMayReplaceCallee, unwrapCallee } from "./expressions/calls-guards.js";
import { emitThrowTypeError } from "./js-errors.js";
import { compileExpression } from "./shared.js";

/** The class this callee denotes, when it is a class of THIS program. */
function sourceClassForCallee(ctx: CodegenContext, callee: ts.Expression): ts.ClassLikeDeclaration | undefined {
  if (ts.isClassExpression(callee)) return callee;
  if (!ts.isIdentifier(callee)) return undefined;
  const declaration = ctx.oracle.valueDeclarationOf(callee);
  if (declaration === undefined) return undefined;
  // Ambient/lib declarations model the callable builtins — never intercept.
  if (declaration.getSourceFile().isDeclarationFile) return undefined;
  if (ts.isClassDeclaration(declaration)) return declaration;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    let init: ts.Expression = declaration.initializer;
    while (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || ts.isNonNullExpression(init)) {
      init = init.expression;
    }
    if (ts.isClassExpression(init)) return init;
  }
  return undefined;
}

/**
 * Emit the §10.2.1 step-2 TypeError for a class constructor invoked without
 * `new`, or return undefined to leave the call to the existing lowerings.
 */
export function tryEmitClassConstructorCallWithoutNew(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
): ValType | undefined {
  if (expr.questionDotToken !== undefined || ts.isOptionalChain(expr)) return undefined;
  const callee = unwrapCallee(expr.expression);
  if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) return undefined;
  if (runtimeEvalMayReplaceCallee(ctx, fctx, callee)) return undefined;

  const classDecl = sourceClassForCallee(ctx, callee);
  if (classDecl === undefined) return undefined;

  // Callee first (side effects), then the argument list, then the throw —
  // the evaluation order of §13.3.6.1, matching #4221's guard.
  const calleeType = compileExpression(ctx, fctx, callee);
  if (calleeType) fctx.body.push({ op: "drop" });
  for (const arg of expr.arguments) {
    const argType = compileExpression(ctx, fctx, arg);
    if (argType) fctx.body.push({ op: "drop" });
  }
  const name = classDecl.name?.text;
  emitThrowTypeError(ctx, fctx, `Class constructor ${name ?? ""} cannot be invoked without 'new'`.replace("  ", " "));
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}
