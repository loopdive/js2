// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6772 S3) `C.call(thisArg, …)` / `C.apply(thisArg, argArray)` on a `class`
 * of THIS program → TypeError.
 *
 * `Function.prototype.call`/`apply` reach the target's [[Call]], and a class
 * constructor's [[Call]] throws (§10.2.1 step 2). #4483 E lowered the direct
 * `C()` spelling (`class-call-without-new.ts`); the reflective spellings fell
 * to the generic call/apply lowering, which ran the constructor body as a
 * plain function. Same shape as #4483 E: the callee expression, then every
 * argument (§13.3.6.1 order), then the throw. `apply`'s
 * CreateListFromArrayLike is not performed (an array-like's `length` getter is
 * not observed — recorded).
 *
 * Narrowing is `sourceClassForCallee`'s: an ambient (`.d.ts`) class models a
 * callable builtin and declines, as does an optional call.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
// (#6797) core helpers through the late-bound delegates, so this leaf stays out of the codegen SCC.
import {
  buildThrowJsErrorInstrs,
  runtimeEvalMayReplaceCallee,
  sourceClassForCallee,
  unwrapCallee,
} from "../helpers/core-delegates.js";
import { compileExpression } from "../shared.js";

/**
 * Does the class, or a source-class ancestor, declare a STATIC member named
 * `name` (`static call() {}`)? Then `C.call(…)` is that member, not
 * `Function.prototype.call`. A computed static key is treated as a match.
 */
function classChainDeclaresStatic(ctx: CodegenContext, decl: ts.ClassLikeDeclaration, name: string): boolean {
  const seen = new Set<ts.ClassLikeDeclaration>();
  for (let c: ts.ClassLikeDeclaration | undefined = decl; c !== undefined && !seen.has(c); ) {
    seen.add(c);
    for (const member of c.members) {
      const isStatic = ts.getCombinedModifierFlags(member as ts.Declaration) & ts.ModifierFlags.Static;
      if (!isStatic || member.name === undefined) continue;
      if (ts.isComputedPropertyName(member.name)) return true;
      if ((ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) && member.name.text === name) return true;
    }
    const extendsClause: ts.HeritageClause | undefined = c.heritageClauses?.find(
      (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
    );
    const heritage: ts.Expression | undefined = extendsClause?.types[0]?.expression;
    c = heritage === undefined ? undefined : sourceClassForCallee(ctx, heritage);
  }
  return false;
}

export function tryEmitClassCtorCallApply(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
): ValType | undefined {
  if (!ctx.standalone) return undefined; // host lane byte-identical (plan: standalone-gated)
  if (expr.questionDotToken !== undefined || ts.isOptionalChain(expr) || ts.isOptionalChain(propAccess)) {
    return undefined;
  }
  const callee = unwrapCallee(propAccess.expression);
  if (runtimeEvalMayReplaceCallee(ctx, fctx, callee)) return undefined;
  const classDecl = sourceClassForCallee(ctx, callee);
  if (classDecl === undefined || classChainDeclaresStatic(ctx, classDecl, propAccess.name.text)) return undefined;
  const calleeType = compileExpression(ctx, fctx, callee);
  if (calleeType) fctx.body.push({ op: "drop" });
  for (const arg of expr.arguments) {
    const argType = compileExpression(ctx, fctx, arg);
    if (argType) fctx.body.push({ op: "drop" });
  }
  const name = classDecl.name?.text;
  const message = `Class constructor ${name ?? ""} cannot be invoked without 'new'`.replace("  ", " ");
  fctx.body.push(...buildThrowJsErrorInstrs(ctx, "TypeError", message, { flush: fctx }));
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}
