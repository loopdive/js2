// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4246) ES5 §10.4.3 step 3 / ES2015+ OrdinaryCallBindThis §10.2.1.2 step 5.b:
// when a **non-strict** function is called with a PRIMITIVE `thisArg`, the
// binding is `ToObject(thisArg)` — a wrapper object — not the primitive.
//
//     function bar() { return typeof this; }
//     bar.call(1)      // "object"   (sloppy)
//     bar.call("1")    // "object"
//
//     function foo() { "use strict"; return typeof this; }
//     foo.call(1)      // "number"   (strict — verbatim)
//
// The nullish half of the same step (`undefined`/`null` → the global object)
// already landed as #4190/#4203 (`helpers/sloppy-this-global.ts`); this is the
// primitive half, which was never supplied — `.call`/`.apply` threaded the raw
// primitive through to `__current_this`, so `typeof this` answered "number" /
// "string" / "boolean" (test262 `language/function-code/10.4.3-1-{1,2,4}-s`).
//
// ## Why a source rewrite rather than an emitter
//
// The receiver reaches the callee through several different lowerings — the
// named-`this` trampoline (`named-this-call.ts`), the closure-receiver install
// (`closure-receiver-install.ts`), the explicit-this-param direct call — each
// with its own operand ordering. Boxing at each of them would put the same
// §10.2.1.2 decision in three places, which is exactly how the strict/sloppy
// answers drift apart. Rewriting `f.call(1, …)` to `f.call(new Number(1), …)`
// puts it in ONE place, *above* the split, and the wrapper it produces is the
// same `$Object`-with-`[[PrimitiveValue]]` that a source-level `new Number(1)`
// already builds in both lanes (#1910/#1472 S2) — so `valueOf`, `.constructor`
// (#4223) and the string-index exotics (#4232) all come out right by
// construction instead of needing their own arms here.
//
// ## The three gates, and what each one is protecting
//
//  1. **The callee must be sloppy.** Strictness is a property of the CALLEE's
//     own code (§10.4.3 keys on the function being entered, not the call site),
//     which is why this resolves the declaration rather than asking about
//     `expr`. `10.4.3-1-1-s` is precisely the pair — same call site, one strict
//     callee and one sloppy — so a call-site test would fail half of it.
//  2. **The body must actually reference its own `this`.** Boxing is
//     semantically harmless when it does not (the value is evaluated and
//     dropped either way), but it would allocate a wrapper — and pull the
//     wrapper runtime into the module — for every `.call(0, …)` in a corpus
//     where the overwhelming majority of callees ignore `this`.
//  3. **The primitive must be PROVEN.** An `any`/union thisArg is left alone:
//     the decision has to be made at runtime and this rewrite cannot express
//     "box only if primitive". Missing a box keeps today's answer; boxing a
//     value that turns out to be an object would be a new wrong answer.
import { ts } from "../../ts-api.js";
import type { CodegenContext } from "../context/types.js";
import { bodyReferencesOwnThis } from "../helpers/body-references-own-this.js";
import { isStrictFunction } from "../helpers/is-strict-function.js";

/** Oracle fact kind → the intrinsic whose `new` builds that primitive's wrapper. */
const WRAPPER_FOR_FACT = new Map<string, string>([
  ["number", "Number"],
  ["string", "String"],
  ["boolean", "Boolean"],
]);

/**
 * (#4246) Rewrite `f.call(<primitive>, …)` / `f.apply(<primitive>, …)` to pass
 * `ToObject(<primitive>)` when `f` is a sloppy function that reads `this`.
 *
 * Returns the reshaped CallExpression for the caller to compile, or `undefined`
 * when any gate declines — in which case the caller's existing dispatch runs
 * unchanged. Deliberately NOT applied to `.bind`: a bound function's
 * [[BoundThis]] is coerced when the bound function is *called*, and the bind
 * carrier stores the raw value (§20.2.3.2 / §10.4.1.1).
 */
export function reshapeSloppyPrimitiveThisArg(
  ctx: CodegenContext,
  expr: ts.CallExpression,
  innerExpr: ts.Expression,
): ts.CallExpression | undefined {
  const thisArg = expr.arguments[0];
  if (thisArg === undefined || ts.isSpreadElement(thisArg)) return undefined;

  const wrapperName = WRAPPER_FOR_FACT.get(ctx.oracle.typeFactOf(thisArg).kind);
  if (wrapperName === undefined) return undefined;

  const callee = resolveSloppyThisReadingCallee(ctx, innerExpr);
  if (callee === undefined) return undefined;

  const boxed = ts.factory.createNewExpression(ts.factory.createIdentifier(wrapperName), undefined, [thisArg]);
  ts.setTextRange(boxed, thisArg);
  (boxed as { parent?: ts.Node }).parent = expr;

  const reshaped = ts.factory.createCallExpression(expr.expression as ts.LeftHandSideExpression, undefined, [
    boxed,
    ...expr.arguments.slice(1),
  ]);
  ts.setTextRange(reshaped, expr);
  (reshaped as { parent?: ts.Node }).parent = expr.parent;
  return reshaped;
}

/**
 * Resolve `innerExpr` (the `.call`/`.apply` receiver) to a function-like
 * declaration that is sloppy AND reads its own `this`; `undefined` otherwise.
 *
 * Arrow functions are excluded on purpose: an arrow has no `this` binding to
 * coerce (§10.2.1.2 is never reached for one), so boxing would allocate a
 * wrapper nothing can observe.
 */
function resolveSloppyThisReadingCallee(
  ctx: CodegenContext,
  innerExpr: ts.Expression,
): ts.FunctionDeclaration | ts.FunctionExpression | undefined {
  let target: ts.Expression = innerExpr;
  while (ts.isParenthesizedExpression(target) || ts.isAsExpression(target) || ts.isNonNullExpression(target)) {
    target = target.expression;
  }

  let declaration: ts.Node | undefined;
  if (ts.isFunctionExpression(target)) {
    declaration = target;
  } else if (ts.isIdentifier(target)) {
    const resolved = ctx.oracle.valueDeclarationOf(target);
    if (resolved === undefined) return undefined;
    if (ts.isFunctionDeclaration(resolved)) {
      declaration = resolved;
    } else if (ts.isVariableDeclaration(resolved) && resolved.initializer !== undefined) {
      // `var f = function () { … this … };` — the same shape one level in.
      const init = resolved.initializer;
      if (ts.isFunctionExpression(init)) declaration = init;
    }
  }

  if (declaration === undefined) return undefined;
  const fn = declaration as ts.FunctionDeclaration | ts.FunctionExpression;
  if (fn.body === undefined) return undefined;
  if (isStrictFunction(fn, ctx.inferModuleStrictArguments)) return undefined;
  if (!bodyReferencesOwnThis(fn.body)) return undefined;
  return fn;
}
