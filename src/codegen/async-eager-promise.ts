// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4630) Eager-async closure Promise wrap — the dynamic-async substrate gap.
 *
 * Under the native-`$Promise` carrier (`isStandalonePromiseActive`), an async
 * function **declaration** that genuinely suspends is drive-lowered and returns
 * a real `$Promise`; every other async shape stays on the legacy synchronous
 * pass-through, whose wasm result is the UNWRAPPED `T`. For a *declaration* that
 * is invisible — the CALL SITE knows the callee is async (`isAsyncCallExpression`
 * → `wrapAsyncReturn`) and mints the `$Promise` there.
 *
 * A function EXPRESSION / arrow passed as a VALUE has no such call site. The
 * `asyncTest(async function () { … })` harness shape calls it through a dynamic
 * closure dispatch, where the callee is only known at runtime, so nothing wraps
 * the result. For the extremely common `async function () { … }` with no
 * `return` the closure's wasm result is *void*, and the dispatch substitutes
 * `undefined` — so `testFunc().then(…)` in test262's `asyncHelpers.js` receives
 * `undefined`, fails the `ref.test $Promise`, has no callable `then`, and throws
 * "Promise.prototype.then called on a non-Promise receiver".
 *
 * Measured 2026-08-23 (plan/issues/4630): ALL 13 `asyncHelpers-throwsAsync-*`
 * standalone harness tests hit this. Twelve of them nevertheless reported PASS,
 * because a SECOND defect cancelled the first: `$DONE`'s parameter was narrowed
 * by call-site inference to `(ref null $Test262Error)`, so the TypeError that
 * `asyncTest`'s `catch (syncError) { $DONE(syncError) }` handed it guard-cast to
 * NULL and `doneprintHandle`'s `if (error)` printed `Test262:AsyncTestComplete`.
 * Widening `$DONE` (the #4630 catch-var withdrawal) merely stopped hiding it.
 *
 * The fix: give a PARKED async closure whose unwrapped result is `void` an
 * `externref` result and settle it through `Promise.resolve(undefined)` (the
 * §27.2.4.7 `emitStandalonePromiseResolve` helper — already promise-idempotent).
 *
 * Scope is deliberately the *void* result only. A parked async closure that
 * returns a VALUE has consumers reading that raw `T` today (`asyncResult
 * ConsumedAsValue`, the #1727 numeric-sink rule); handing them a `$Promise`
 * would unbox to NaN. A void closure has no such consumer — the dispatch
 * currently produces `undefined` and nothing can be reading a value from it —
 * so this arm strictly ADDS information and cannot take any away.
 */
import ts from "typescript";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitStandalonePromiseResolve, isStandalonePromiseActive } from "./async-scheduler.js";
import { emitUndefined } from "./expressions/late-imports.js";

/**
 * Should a PARKED (legacy pass-through) async arrow / function expression get an
 * `externref` `$Promise` result instead of its unwrapped one? `closureReturnType`
 * is the signature the normal path computed — `null` means the unwrapped result
 * is `void`, the only shape this claims (see the module header).
 */
export function parkedAsyncClosureWrapsPromise(
  ctx: CodegenContext,
  closureReturnType: { kind: string } | null,
): boolean {
  return isStandalonePromiseActive(ctx) && closureReturnType === null;
}

/**
 * Consume one `externref` from the stack and leave the `$Promise` that an async
 * function's completion value settles to. Idempotent for a value that already IS
 * a native `$Promise` (an async body's `return somePromise` adopts it, §27.2.4.7
 * step 2) because `emitStandalonePromiseResolve` performs that test itself.
 */
export function emitEagerAsyncPromiseWrap(ctx: CodegenContext, fctx: FunctionContext): void {
  const tmp = allocLocal(fctx, `__eager_async_ret_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: tmp });
  const valueInstrs: Instr[] = [{ op: "local.get", index: tmp }];
  emitStandalonePromiseResolve(ctx, fctx, valueInstrs);
}

/**
 * (#4630 item A prerequisite) The DECLARATION analogue of
 * {@link parkedAsyncClosureWrapsPromise}.
 *
 * `asyncTest(foo)` with `async function foo() { … }` has the same defect the
 * closure arm fixed, one indirection further out. A *direct* call `foo()` is
 * repaired at the CALL SITE (`wrapAsyncReturn` mints the `$Promise` there
 * because the site can see the callee is async), but `foo` referenced **as a
 * value** flows through the cached func-closure singleton
 * (`ensureFuncClosureSingleton`), whose trampoline forwards verbatim into the
 * void-returning wasm function — so the dynamic dispatch inside `asyncTest`
 * substitutes `undefined` and `testFunc().then(…)` throws the §27.2.5.4
 * non-Promise-receiver TypeError. Four standalone tests sit on exactly this:
 * `language/statements/async-function/evaluation-this-value-global.js` and the
 * three `language/expressions/await/syntax-await-*` files.
 *
 * ## Why the promotion is on the TRAMPOLINE, not on the function
 *
 * The obvious fix — promote the declaration's own wasm result from void to
 * `externref` — is the one the issue file flags as an ordering hazard:
 * `wrapAsyncReturn` reads `wasmFuncReturnsVoid(funcIdx)` **at each call site**,
 * so promoting the result after some call sites have already compiled leaves
 * those sites believing nothing is on the stack while the callee now pushes a
 * value — a stack desync, and one that depends on source order. Promoting only
 * the *value view* (the singleton's wrapper type + trampoline) leaves every
 * direct call site's `wasmFuncReturnsVoid` answer, and the function's own
 * signature, bit-identical. The two views are already allowed to differ — that
 * is what `finalizeMethodTrampolines`' wrapper-vs-method reconciliation exists
 * for.
 *
 * ## The gate, and why it is order-independent
 *
 * `results` is the callee signature as known *right now*, which may still be
 * provisional (this is why `finalizeMethodTrampolines` rebuilds bodies at all).
 * The gate therefore pairs it with a purely syntactic void check, which is a
 * function of the AST alone and cannot drift:
 *
 *  - final result stays void      → the wrap arm settles `undefined` (the fix);
 *  - final result became `externref` (the callee turned out drive-lowered and
 *    already returns a real `$Promise`) → the finalize arm's
 *    `emitStandalonePromiseResolve` passes it through unchanged (§27.2.4.7
 *    step 2), so the promoted wrapper is still correct;
 *  - a value-returning async declaration is excluded up front by the syntactic
 *    check, so the #1727 raw-`T` consumers this must not disturb are never
 *    reached.
 */
export function parkedAsyncDeclarationWrapsPromise(
  ctx: CodegenContext,
  decl: ts.FunctionDeclaration | undefined,
  results: readonly ValType[],
): boolean {
  if (!isStandalonePromiseActive(ctx)) return false;
  // Only the void-result shape — the same scoping as the closure arm.
  if (results.length !== 0) return false;
  if (!decl || decl.body === undefined) return false;
  if (decl.asteriskToken !== undefined) return false; // async generator: not a Promise
  if (!(decl.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
  return !functionBodyReturnsAValue(decl.body);
}

/** Does this body contain a `return <expr>` of its OWN (nested functions excluded)? */
function functionBodyReturnsAValue(body: ts.Block): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return; // a nested function's `return` is not ours
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(body, walk);
  return found;
}

/**
 * Leave the `$Promise` an async function's *void* completion settles to on the
 * stack, consuming nothing. `Promise.resolve(undefined)` — routed through the
 * same §27.2.4.7 helper as every other settle so the promise object is
 * byte-identical to the one a `return;` would produce.
 */
export function emitEagerAsyncUndefinedPromise(ctx: CodegenContext, fctx: FunctionContext): void {
  const before = fctx.body.length;
  emitUndefined(ctx, fctx);
  const valueInstrs = fctx.body.splice(before);
  emitStandalonePromiseResolve(ctx, fctx, valueInstrs);
}
