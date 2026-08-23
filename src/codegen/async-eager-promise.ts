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
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { emitStandalonePromiseResolve, isStandalonePromiseActive } from "./async-scheduler.js";

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
