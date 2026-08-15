// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4480 S2) §13.2.2 [[Construct]] step 6 — a `new F()` instance's
 * [[Prototype]] IS the object `F.prototype` reads.
 *
 * The spec exposes that through two read points. This module serves
 * `Object.getPrototypeOf(i)`. The sibling read point
 * `F.prototype.isPrototypeOf(i)` is NOT served, and the reason is measured
 * rather than assumed: writing the call at all is a dynamic method use on `F`'s
 * prototype, which demotes `F` out of the #2660 escape gate's approved set, so
 * condition 1 below can never hold at that site. The instrumented evidence is
 * recorded in native-is-prototype-of.ts and in #4480's Residuals — the blocker
 * there is the escape gate, not the chain walk.
 *
 * ## The gap S1 left open, measured
 *
 * S1 gave every ordinary function a stable `.prototype` `$Object` in the
 * per-fnctor global `__fnctor_proto_<F>`. It did NOT give the instance a link to
 * it, because a `new F()` whose body assigns `this.x` (and, as it turns out,
 * even one whose body is EMPTY) does not lower to an `$Object` at all — it
 * lowers to the bespoke `$__fnctor_<F>` WasmGC struct minted by new-super.ts,
 * which has no `$proto` field. Measured on this branch (probe `.tmp/probe3.mts`,
 * `--target standalone`, runs executed for this issue):
 *
 *   | shape                                                                   | S1    | spec |
 *   | ----------------------------------------------------------------------- | ----- | ---- |
 *   | `function F(){this.x=1}; Object.getPrototypeOf(new F()) === F.prototype` | false | true |
 *   | `function F(){this.x=1}; F.prototype.isPrototypeOf(new F())`             | false | true |
 *   | `function F(){};        F.prototype.isPrototypeOf(new F())`              | false | true |
 *
 * Row 1 is the one this module fixes, and it shows the change is a REPAIR
 * rather than a widening: `F.prototype`
 * already answered the S1 global while `Object.getPrototypeOf(i)` answered
 * something else, so the module contradicted itself. The `$Object.$proto` walk
 * `__isPrototypeOf` performs opens with `ref.test (ref $Object)` on the VALUE,
 * which a `$__fnctor_<F>` struct fails, so the loop exits before its first
 * iteration and the walk answers `0` — visible in the emitted WAT.
 *
 * ## The arm — a static [[Prototype]], not a stored one
 *
 * The bespoke struct is minted per-CONSTRUCTOR, so `ref.test (ref $__fnctor_F)`
 * is itself the [[Prototype]] question: a value of that type was constructed by
 * `F` and by nothing else (plain functions have no subtyping, so the test is
 * exact). This is the SAME reasoning — and the same `ref.test` — that
 * `native-user-instanceof.ts` (#3962) already ships for `x instanceof F`; this
 * module states it once so `isPrototypeOf` and `getPrototypeOf` cannot drift
 * from `instanceof`.
 *
 * ## Two conditions, both load-bearing (absent-not-wrong)
 *
 *  1. **`resolveUserFnctorName` must resolve `F`.** That is precisely the
 *     predicate under which a `F.prototype` READ is answered from
 *     `__fnctor_proto_<F>`. Answering the instance's [[Prototype]] from that
 *     global while the `.prototype` read came from somewhere else (the closure's
 *     own-property bag, for a `keep-typed` fnctor) would publish an identity
 *     that is false in the module's own terms — a WRONG answer where today
 *     there is merely a missing one, the one trade this campaign forbids.
 *
 *  2. **No whole-reassignment `F.prototype = …` anywhere in the file.** The
 *     global is a single mutable cell, so with a reassignment present an
 *     instance built BEFORE it and read AFTER it has a [[Prototype]] the global
 *     no longer holds (§13.2.2 captures the value at construction). With zero
 *     reassignments the global is write-once-on-vivify and the identity is
 *     unconditional. A per-property write (`F.prototype.p = v`) mutates that
 *     same object and is explicitly NOT a reassignment, so the ordinary
 *     prototype-method idiom keeps the arm. This is what makes the arm decline
 *     on `S13.2.2_A1_T1` (`__FACTORY.prototype = __PROTO`) rather than answer it
 *     by luck; that family needs a function-valued prototype the
 *     `(ref null $Object)` field cannot hold, and is recorded as a residual.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitFnctorProtoGet, resolveUserFnctorName } from "./expressions/fnctor-prototype.js";
import { identifierIsWrittenTo } from "./native-ordinary-instanceof.js";
import type { InnerResult } from "./shared.js";
import { compileExpression } from "./shared.js";

/**
 * True when `file` contains a WHOLE reassignment of `<name>.prototype`. A
 * per-property write (`F.prototype.p = v`) is deliberately not matched: it
 * mutates the object the global already holds, so it cannot desynchronize the
 * global from an instance's captured [[Prototype]].
 */
function hasWholePrototypeReassignment(file: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "prototype" &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === name
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The `$__fnctor_<name>` struct type index for a user function constructor whose
 * `.prototype` is served by the S1 per-fnctor global, or `undefined` to decline.
 * Both conditions from this module's header are checked here, so every consumer
 * inherits them.
 */
function fnctorInstanceStructTypeIdx(ctx: CodegenContext, ctorId: ts.Identifier): number | undefined {
  const name = ctorId.text;
  if (ctx.classSet.has(name)) return undefined;
  if (ctx.generatorFunctions.has(name)) return undefined;
  const structTypeIdx = ctx.structMap.get(`__fnctor_${name}`);
  if (typeof structTypeIdx !== "number" || structTypeIdx < 0) return undefined;
  // Condition 1 — the `.prototype` read resolves to the same global.
  if (resolveUserFnctorName(ctx, ctorId) !== name) return undefined;
  // Condition 2 — the global is never re-pointed.
  if (hasWholePrototypeReassignment(ctorId.getSourceFile(), name)) return undefined;
  return structTypeIdx;
}

/**
 * `expr` provably evaluates to a `new <F>()` instance of a user fnctor whose
 * `.prototype` is served by the S1 global → `F`'s name, else `undefined`.
 * Accepts a direct `new F(…)` and a single-assignment binding initialized with
 * one; the single-assignment requirement is what makes the static answer sound
 * (a rebindable name could hold anything at the read site).
 */
function resolveFnctorInstanceCtorName(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  let target: ts.Expression = expr;
  if (ts.isIdentifier(target)) {
    const initializer = ctx.oracle.variableInitializerOf(target);
    if (!initializer) return undefined;
    if (identifierIsWrittenTo(target.getSourceFile(), target.text)) return undefined;
    target = initializer;
  }
  if (!ts.isNewExpression(target)) return undefined;
  if (!ts.isIdentifier(target.expression)) return undefined;
  return fnctorInstanceStructTypeIdx(ctx, target.expression) === undefined ? undefined : target.expression.text;
}

/**
 * `Object.getPrototypeOf(arg)` where `arg` is provably a `new F()` instance of a
 * user fnctor → the per-fnctor prototype `$Object`. Leaves an externref on the
 * stack and returns its type, or `null` to decline (the caller continues its
 * existing dispatch unchanged).
 *
 * The caller must invoke this AFTER its top-level-function arm — so
 * `Object.getPrototypeOf(F)` still reports %Function.prototype% rather than
 * `F`'s own prototype object — and BEFORE the ES5 value arm, so a `new F()`
 * binding is not first mapped through `ES5_OBJECT_PROTOTYPES`.
 */
export function tryCompileFnctorInstanceGetPrototypeOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  arg0: ts.Expression,
): InnerResult | null {
  if (!ctx.standalone && !ctx.wasi) return null;
  const ctorName = resolveFnctorInstanceCtorName(ctx, arg0);
  if (ctorName === undefined) return null;
  // §20.1.2.12 evaluates its argument; keep the side effects of e.g. a direct
  // `Object.getPrototypeOf(new F())` before answering. This `compileExpression`
  // overload returns `ValType | null` (never the `VOID_RESULT` sentinel), so the
  // null check alone keeps the stack balanced.
  const argType = compileExpression(ctx, fctx, arg0);
  if (argType !== null) fctx.body.push({ op: "drop" });
  if (emitFnctorProtoGet(ctx, fctx, ctorName)) return { kind: "externref" };
  // The proto-get declined without emitting anything (its contract), but the
  // argument is already compiled and dropped, so answer the host-free null the
  // fallback would have produced rather than leaving the stack unbalanced.
  fctx.body.push({ op: "ref.null.extern" });
  return { kind: "externref" };
}
