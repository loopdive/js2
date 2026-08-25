// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4190) ES5 §10.4.3 "Entering Function Code" — the unbound-receiver `this`.
 *
 * When a function is called with no receiver (`f()`, `f.call(null)`,
 * `f.apply(undefined)`, `f.bind(null)()`), the value bound to `this` inside
 * the callee depends ONLY on the callee's own strictness:
 *
 *   1. If the function code is strict code, `this` is the passed thisArg
 *      verbatim — `undefined` / `null` stay `undefined` / `null`.
 *   2. Otherwise (sloppy code), `this` is the **global object**.
 *
 * (ES2015+ restates this as OrdinaryCallBindThis §10.2.1.2 step 5: sloppy code
 * substitutes the global object for `undefined`/`null` and `ToObject`s a
 * primitive; the observable answer for the unbound case is identical.)
 *
 * The codegen's ThisKeyword arm falls through to `undefined` whenever it finds
 * no receiver binding. That is correct for (1) and wrong for (2), which is the
 * entire `language/function-code/10.4.3-1-*` family plus the
 * `Function.prototype.{call,apply}` thisArg shapes.
 *
 * This predicate is deliberately narrow: it answers only "is the code around
 * this `this` sloppy?", and every caller applies it strictly *after* exhausting
 * the real receiver-binding paths (typed-this param, `localMap`, static class
 * context, `__module_init`, a live `__current_this`). It never widens WHICH
 * bodies consult a receiver — it only changes the value of the terminal
 * fallback, from `undefined` to `globalThis`, for sloppy code.
 *
 * Why not just always read `__current_this`: #1636-S1 tried that and regressed
 * 171 tests, because a directly-called function never has it installed and so
 * observes the global's `ref.null.extern` initial value as `null` rather than
 * the spec value. The null-guard added by #1702 fixed the strict half; this is
 * the sloppy half, which was never supplied.
 */
import { ts } from "../../ts-api.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileIdentifier } from "../expressions/identifiers.js";
import { inlinedCalleeHasBoundReceiver } from "../expressions/inlined-call-receiver.js"; // (#4555)
import { emitUndefined } from "../expressions/late-imports.js";
import { coerceType } from "../shared.js";
import { isStrictContext } from "./is-strict-function.js";

/**
 * True when an unbound `this` at `expr` must evaluate to the global object
 * rather than `undefined` — i.e. `expr` sits in sloppy (non-strict) code.
 *
 * `inferModuleStrictArguments` is threaded through so the test262 harness's
 * synthetic `export function test()` wrapper does not make a genuinely sloppy
 * script look like strict module code (the same flag every other strictness
 * consumer in codegen passes; see #2119).
 */
export function unboundThisIsGlobalObject(ctx: CodegenContext, expr: ts.Node): boolean {
  return !isStrictContext(expr, ctx.inferModuleStrictArguments);
}

/**
 * (#4190) Emit the value of an unbound `this` as an `externref`, per the split
 * above: `globalThis` for sloppy code (and for a sloppy direct-eval body, which
 * already had this answer), `undefined` for strict code.
 *
 * Both call sites in the `ThisKeyword` arm delegate here so the strict/sloppy
 * decision exists in exactly one place, and so the god-file driver
 * (`expressions.ts`) does not grow the emission logic.
 */
export function emitUnboundThis(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Node): void {
  if (fctx.directEvalSloppyThisFallback || unboundThisIsGlobalObject(ctx, expr)) {
    emitGlobalObjectAsThis(ctx, fctx);
    return;
  }
  emitUndefined(ctx, fctx);
}

/**
 * (#4203) The §10.4.3 answer for a receiver the caller passed **explicitly as
 * `null`**, which is NOT the same question as `emitUnboundThis`'s.
 *
 * Strict code observes the thisArg verbatim, so it gets `null` — where an
 * *absent* receiver would get `undefined`. That difference is the entire point
 * of the marker in `explicit-null-receiver.ts`; without it the two states share
 * one spelling and the strict rows (`10.4.3-1-{67,72,77}`) cannot pass.
 *
 * The sloppy answer is deliberately IDENTICAL to the unbound one — §10.4.3
 * substitutes the global object for `null` and `undefined` alike — so this must
 * NOT be read as "stop coercing null". Sloppy `f.call(null)` is still the global
 * object, and getting that wrong is the trap this split exists to avoid.
 */
export function emitExplicitNullThis(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Node): void {
  if (fctx.directEvalSloppyThisFallback || unboundThisIsGlobalObject(ctx, expr)) {
    emitGlobalObjectAsThis(ctx, fctx);
    return;
  }
  fctx.body.push({ op: "ref.null.extern" });
}

/** Push the global object as an `externref` — the sloppy arm of both answers. */
function emitGlobalObjectAsThis(ctx: CodegenContext, fctx: FunctionContext): void {
  const globalType = compileIdentifier(ctx, fctx, ts.factory.createIdentifier("globalThis"));
  if (globalType && globalType.kind !== "externref") {
    coerceType(ctx, fctx, globalType, { kind: "externref" });
  }
}

/**
 * (#4190) True when `expr` — a `this` — belongs **lexically** to top-level
 * Script code, i.e. no `this`-binding construct encloses it before the
 * SourceFile. Arrow functions are transparent (they inherit `this`); every
 * other function form, and any class body, introduces its own binding.
 *
 * This guards the §3365 "Script-goal top-level `this` is the global object"
 * arm. That arm keys on `fctx.name === "__module_init"`, which is a statement
 * about the *emitted* function, not about the source. An IIFE at top level is
 * INLINED into `__module_init` (`compileIIFE`), so its body's `this` — which
 * belongs to the function expression, not to the script — was taking the
 * top-level arm and evaluating to the global object even under a
 * `"use strict"` prologue. That is the whole `10.4.3-1-*gs` family:
 *
 *     (function () { "use strict"; return typeof this; })()   // "object", want "undefined"
 *     var f = function () { "use strict"; return typeof this; }; f()   // already correct
 *
 * — the only difference between the two lines being whether the callee was
 * inlined. Verified pre-existing: the same divergence reproduces with this
 * file's other change reverted.
 */
export function thisBelongsToTopLevelCode(expr: ts.Node): boolean {
  for (let node: ts.Node | undefined = expr.parent; node; node = node.parent) {
    if (ts.isSourceFile(node)) return true;
    if (ts.isArrowFunction(node)) continue; // transparent — inherits `this`
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return false;
    }
  }
  return false;
}

/**
 * (#4202) True when a `this` used as a **`.call`/`.apply` receiver** provably
 * compiles to the global object, so the receiver-install trampoline in
 * `named-this-call.ts` may take its live arm.
 *
 * This mirrors the `ThisKeyword` lowering's own #3365/#4190 arm rather than
 * approximating it: the three earlier bindings that arm consults first (a
 * typed-this parameter, a `this` in `localMap`, a static class context) are
 * ruled out in the same order, and only then does top-level Script code
 * answer `globalThis`. Keeping the two in one module is the point — a
 * predicate that drifted from the lowering would install a receiver the
 * callee does not read, or refuse one it does.
 *
 * The question is deliberately "does it evaluate to the global object?", NOT
 * "is it non-null?". Widening to non-nullness would be wrong, not merely
 * broad: a `this` that compiles through `emitUndefined` yields the
 * `$__undefined` singleton, which IS a non-null externref. Installing that
 * defeats the callee body's `ref.is_null` fallback — and for a **sloppy**
 * callee that fallback is the only thing delivering §10.4.3's global object
 * for an `undefined` thisArg. So the gate proves the value, not the pointer.
 */
export function thisReceiverIsGlobalObject(ctx: CodegenContext, fctx: FunctionContext, receiver: ts.Node): boolean {
  if (process.env.JS2WASM_TWIN_RECEIVER_PARAM !== "0" && fctx.typedThisLocalIdx !== undefined) return false;
  if (fctx.localMap.get("this") !== undefined) return false;
  if (fctx.isStaticContext) return false;
  return fctx.name === "__module_init" && !ctx.sourceIsModule && thisBelongsToTopLevelCode(receiver);
}

/**
 * (#4205) True when a MEMBER-ACCESS receiver provably evaluates to the realm
 * global object — script top-level `this` (per {@link thisReceiverIsGlobalObject})
 * or a `globalThis` that nothing shadows.
 *
 * Why any caller needs this: the TypeScript checker types both of those as
 * `typeof globalThis`, which `resolveStructName` happily resolves to the large
 * static global-interface struct. Every member fast path keyed on "did I get a
 * struct name?" then treats the realm global object as that struct and answers
 * from its declared fields — so a property created at runtime by
 * `this.n = 1` / `globalThis.n = 1` is simply not there, and the fast path
 * emits its missing-field fallback (`f64.const NaN`, `undefined`, a `ref.cast`
 * that traps) instead of consulting the object.
 *
 * The same hazard is already called out, gOPD-locally, on
 * `isScriptGlobalThisReceiver` in `expressions/call-builtin-static.ts`; this is
 * the shared predicate that lets other member paths opt out of the struct fast
 * path for the same reason, in every target (the object is real in standalone
 * too — `emitNativeGlobalThisObject`'s `$Object` singleton, #2996).
 */
export function receiverIsRealmGlobalObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
): boolean {
  let cur: ts.Expression = receiver;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  if (cur.kind === ts.SyntaxKind.ThisKeyword) return thisReceiverIsGlobalObject(ctx, fctx, cur);
  if (!ts.isIdentifier(cur) || cur.text !== "globalThis") return false;
  return fctx.localMap.get("globalThis") === undefined && !ctx.moduleGlobals.has("globalThis");
}

/**
 * (#4555) True when `expr` — a `this` — lexically belongs to the body of a
 * **non-arrow function expression that the inline-IIFE path spliced into the
 * current function** (`fctx.inlinedIifeNodes`, recorded by
 * `call-tail-dispatch.ts`).
 *
 * The inliner emits the callee's body with no separate activation, so the
 * `ThisKeyword` arm sees the ENCLOSING function's receiver bindings —
 * `typedThisLocalIdx`, or a `this` in `localMap`. For a function expression
 * that is wrong: `(function(){ … })()` is called with no receiver, so §10.4.3
 * gives it the global object (sloppy) or `undefined` (strict), never the
 * caller's `this`. Inside a constructor twin the divergence is visible:
 *
 *     function FACTORY() { (function(){ this.feat = "x"; })(); }
 *     new FACTORY;            // wrote `feat` onto the INSTANCE, not the global
 *
 * — and, because the enclosing receiver is a typed struct, a `this.<prop>`
 * read in the inlined body compiled to a `ref.cast` against that struct and
 * trapped outright.
 *
 * Arrow functions are deliberately transparent here: an arrow DOES inherit the
 * enclosing `this`, so the inliner's reuse of the caller's bindings is exactly
 * right for them and this predicate must not fire.
 *
 * `thisBelongsToTopLevelCode` answers the sibling question for the `__module_init`
 * arm; this one covers every other enclosing function, which that arm never
 * reaches because the receiver-binding arms run first.
 */
export function thisBelongsToInlinedIifeBody(fctx: FunctionContext, expr: ts.Node): boolean {
  if (fctx.inlinedIifeNodes === undefined || fctx.inlinedIifeNodes.size === 0) return false;
  for (let node: ts.Node | undefined = expr.parent; node; node = node.parent) {
    if (ts.isSourceFile(node)) return false;
    if (ts.isArrowFunction(node)) continue; // transparent — inherits `this`
    if (ts.isFunctionExpression(node)) {
      // (#4246) A receiver-bound inline is NOT a receiver-less IIFE: its `this`
      // is the value the caller passed, installed in `localMap` by
      // `planInlinedReceiver`. Defer to that rung rather than overriding it.
      if (inlinedCalleeHasBoundReceiver(node)) return false;
      return fctx.inlinedIifeNodes.has(node);
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return false;
    }
  }
  return false;
}
