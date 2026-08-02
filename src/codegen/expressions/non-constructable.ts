// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4017) `new <callee>` non-constructability analysis, lifted out of the
// `new-super.ts` god-file (#3102 LOC budget).
//
// The whole subsystem is one question — "does this callee have [[Construct]]?" —
// answered at two different STRENGTHS, and keeping the strengths straight is
// what makes the analysis safe. See `classifyNonConstructableValue`.
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";

/**
 * (#2886) Does `id` resolve to the **ambient global** binding (declared only in
 * the TypeScript lib `.d.ts` files), rather than a user-defined shadow? A user
 * who writes `function parseInt() {}` (or `class isNaN {}`) has a declaration in
 * a real source file and *is* constructable — we must not intercept those. The
 * ambient builtin's symbol has all of its declarations in declaration files.
 * Unresolved symbols (no declaration anywhere) are treated as the global.
 */
export function resolvesToAmbientGlobal(ctx: CodegenContext, id: ts.Identifier): boolean {
  const sym = ctx.checker.getSymbolAtLocation(id);
  if (!sym) return true;
  const decls = sym.declarations;
  if (!decls || decls.length === 0) return true;
  return decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * The strength of a non-constructability conclusion.
 *
 *   `"probe"`    — non-constructable *as far as a static reading goes*, but the
 *                  conclusion is only safe behind a runtime `IsConstructor`
 *                  re-check. `.bind()` / `.call()` / `.apply()` initializers are
 *                  exactly this: a **bound** function IS a constructor when its
 *                  target is (§10.4.1.2), and `f.call(x)` / `f.apply(x)` RETURN
 *                  an arbitrary value that may itself be a constructor
 *                  (`var C = mk.call(null); new C()`). The host `__construct`
 *                  helper supplies that re-check.
 *   `"provable"` — decided at COMPILE time; no probe needed, so a target with no
 *                  host imports at all (standalone / WASI) can emit the
 *                  `TypeError` directly.
 */
export type NonCtorProof = "no" | "probe" | "provable";

/**
 * (#1732 S1) Classify a `new <id>` callee identifier by the shape of its
 * declaration's initializer.
 *
 *   - `<expr>.prototype.<method>` — a method pulled off a prototype.
 *     `"provable"` when the receiver is an **ambient intrinsic**: §10.3 gives a
 *     built-in function `[[Construct]]` only where the spec says so, and no
 *     `X.prototype.<method>` does. This is the `S15.5.4.*_A7` pattern
 *     (`var f = String.prototype.indexOf; new f`). Otherwise `"probe"` — a
 *     **user** `function Foo(){}; Foo.prototype.bar = function(){}` makes `bar`
 *     an ordinary function that DOES have `[[Construct]]`, so `new f` must not
 *     be rejected out of hand.
 *   - an **arrow-function** initializer — `"provable"` (§15.3: arrows have no
 *     `[[Construct]]`). Through a local of type `any` (`const f = () => 1`) no
 *     static guard sees the arrow, so without this the unknown-ctor path is
 *     reached and wrongly does not throw (#1528a).
 *   - `<expr>.bind(...)` / `.call(...)` / `.apply(...)` — `"probe"` only.
 *
 * Deliberately conservative: any other initializer shape (function expression,
 * class reference, plain identifier, call to a factory, …) is `"no"`, so those
 * keep the existing static / unknown-ctor handling. User function declarations
 * are resolved by the caller well before this and never reach here.
 *
 * (#4017) Reporting the strength rather than a boolean is the point: emitting an
 * unconditional throw for a `"probe"` shape would reject legitimate
 * constructions, which is a worse defect than the missing throw it would fix.
 * One symbol lookup serves both callers.
 */
export function classifyNonConstructableValue(ctx: CodegenContext, calleeExpr: ts.Expression): NonCtorProof {
  if (!ts.isIdentifier(calleeExpr)) return "no";
  const sym = ctx.checker.getSymbolAtLocation(calleeExpr);
  const decls = sym?.getDeclarations();
  if (!decls || decls.length === 0) return "no";

  const classifyInit = (init: ts.Expression): NonCtorProof => {
    // Unwrap as/paren/non-null wrappers.
    let e: ts.Expression = init;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) {
      e = ts.isParenthesizedExpression(e)
        ? e.expression
        : ts.isAsExpression(e)
          ? e.expression
          : (e as ts.NonNullExpression).expression;
    }
    if (ts.isArrowFunction(e)) return "provable";
    if (ts.isPropertyAccessExpression(e)) {
      const obj = e.expression;
      if (ts.isPropertyAccessExpression(obj) && obj.name.text === "prototype") {
        return ts.isIdentifier(obj.expression) && resolvesToAmbientGlobal(ctx, obj.expression) ? "provable" : "probe";
      }
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
      const m = e.expression.name.text;
      if (m === "bind" || m === "call" || m === "apply") return "probe";
    }
    return "no";
  };

  let best: NonCtorProof = "no";
  for (const decl of decls) {
    // `var/let/const f = <init>`
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      const k = classifyInit(decl.initializer);
      if (k === "provable") return "provable";
      if (k === "probe") best = "probe";
    }
  }
  return best;
}

/** Any non-constructable conclusion, at either strength (the pre-#4017 boolean). */
export function resolvesToNonConstructableValue(ctx: CodegenContext, calleeExpr: ts.Expression): boolean {
  return classifyNonConstructableValue(ctx, calleeExpr) !== "no";
}

/** Compile-time-decided only — safe to throw with no runtime probe available. */
export function provablyNonConstructableStatically(ctx: CodegenContext, calleeExpr: ts.Expression): boolean {
  return classifyNonConstructableValue(ctx, calleeExpr) === "provable";
}
