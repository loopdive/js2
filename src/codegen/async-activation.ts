// (#2957 phase 1) Shared async state-machine activation entry point.
//
// The async/await CPS + drive activation logic was previously inlined inside
// `compileFunctionBody` and gated on `ts.isFunctionDeclaration`, so it was
// unreachable from the arrow (`closures.ts`), class-method (`class-bodies.ts`)
// and object-literal-method (`literals.ts`) body-compile paths — those shapes
// silently fell through to the legacy synchronous pass-through and never
// activated a state machine (#2957 root-cause).
//
// This module factors that block into a single reusable
// `maybeActivateAsync(ctx, fctx, decl, func)` helper. Phase 1 is a **pure,
// byte-inert extraction**: `compileFunctionBody` calls it and the internal
// `ts.isFunctionDeclaration` guards are preserved verbatim, so no shape's
// emitted bytes change. Phases 2–3 wire the same entry point into the three
// other body-compile paths (the real behaviour change) and, at that point,
// relax the declaration guards.

import { ts } from "../ts-api.js";
import type { ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import type { AsyncCpsPlan } from "./async-cps.js";
import {
  ASYNC_CPS_ENABLED,
  analyzeAsyncBody,
  asyncFnNeedsCps,
  emitAsyncStateMachine,
  splitBodyAtAwait,
} from "./async-cps.js";
import {
  emitAsyncFrameStateMachine,
  asyncFnNeedsDrive,
  asyncFnNeedsHostDrive,
  asyncGenConsumerNeedsDrive,
} from "./async-frame.js";
import { isStandalonePromiseActive } from "./async-scheduler.js";

/**
 * Rewrite a compiled function's registered result type. An activated async
 * function returns a real Promise object (externref), not the unwrapped value.
 */
function rewriteFuncResultType(ctx: CodegenContext, func: WasmFunction, result: ValType): void {
  const ft = ctx.mod.types[func.typeIdx];
  if (!ft || ft.kind !== "func") return;
  func.typeIdx = addFuncType(ctx, ft.params.slice(), [result]);
}

/**
 * Which async lowering lane a function-like node activates.
 *  - `drive`      — host-free `$AsyncFrame` resume machine (wasi carrier).
 *  - `cps`        — JS-host single-tail-await CPS state machine.
 *  - `host-drive` — JS-host N-state resume machine (multi-await / try-finally).
 */
export type AsyncLane = "drive" | "cps" | "host-drive";

export interface AsyncActivationPlan {
  readonly lane: AsyncLane;
  readonly plan: AsyncCpsPlan;
}

/**
 * Pure activation DECISION (no emission, no type rewrite): decide whether an
 * async `decl` should be lowered to a state machine and, if so, on which lane.
 * Returns `null` when the legacy synchronous pass-through applies.
 *
 * `allowNonDeclaration` gates the `ts.isFunctionDeclaration` restriction that
 * phase 1 preserved for byte-identity: the `compileFunctionBody` entry passes
 * `false` (declaration-only, unchanged); the arrow / function-expression /
 * method paths (phase 2+) pass `true` so the SAME gating applies to those
 * shapes. `isAsync` is supplied by the caller because the closure paths key
 * async-ness off the AST modifier (the synthetic `__closure_N` name is not in
 * `ctx.asyncFunctions`), while `compileFunctionBody` keys off the func name.
 */
function decideAsyncActivation(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  isAsync: boolean,
  allowNonDeclaration: boolean,
): AsyncActivationPlan | null {
  if (!ASYNC_CPS_ENABLED || !isAsync || !decl.body) return null;
  if (!allowNonDeclaration && !ts.isFunctionDeclaration(decl)) return null;

  // (#2895 PATH B) Host-free async drive layer. Gated on the native-`$Promise`
  // *carrier* (`isStandalonePromiseActive`, currently `wasi`-only): when the
  // awaited operand resolves to a native `$Promise`, a genuinely-suspending
  // async fn is driven by a real resumable `$AsyncFrame`. The result is a real
  // `$Promise` (externref), not a sync value.
  if (isStandalonePromiseActive(ctx)) {
    const asyncPlan = analyzeAsyncBody(ctx, decl);
    // (#2906) Drive-layer eligibility accepts linear MULTI-await bodies, not
    // just the single canonical await `asyncFnNeedsCps` gates on. For a single
    // await the verdict is identical, so wasi single-await routing is unchanged.
    if (asyncFnNeedsDrive(ctx, decl, asyncPlan)) return { lane: "drive", plan: asyncPlan };
    return null;
  }

  // (#2865) `--target standalone` with the native-`$Promise` CARRIER gate still
  // OFF (#2980 — the measured widen decision): activate the drive lane ONLY for
  // the for-await-over-async-GENERATOR consumer shape. Its every suspension
  // awaits a promise MINTED by the machine itself (the producer's
  // `__async_gen_next_<name>` next()-promise — a native `$Promise` on every
  // lane), so it is carrier-independent. Plain awaits / Promise statics /
  // boxed-array for-await stay on the legacy path until the carrier widen —
  // widening those here would be exactly the piecemeal flip #2980 rule 2 declines.
  if (ctx.standalone === true) {
    const asyncPlan = analyzeAsyncBody(ctx, decl);
    if (asyncGenConsumerNeedsDrive(ctx, decl, asyncPlan)) return { lane: "drive", plan: asyncPlan };
    return null;
  }

  // JS-host lanes (never both wasi and standalone).
  if (!ctx.wasi && !ctx.standalone) {
    const asyncPlan = analyzeAsyncBody(ctx, decl);
    if (asyncFnNeedsCps(decl, asyncPlan)) return { lane: "cps", plan: asyncPlan };
    // (#1042 July re-scope) JS-host N-state resume machine with HOST-Promise
    // settle adapters — claims the linear shapes the single-tail-await CPS lane
    // rejects (multi-await, try/finally-across-await).
    if (asyncFnNeedsHostDrive(ctx, decl, asyncPlan)) return { lane: "host-drive", plan: asyncPlan };
  }

  return null;
}

/**
 * Emit the async body for a decided lane into `fctx.body`. Does NOT rewrite the
 * result type — callers that own the signature (the closure path bakes
 * `externref` into the lifted func/struct type up front) must ensure
 * `fctx.returnType` is already `externref`. The `compileFunctionBody` entry
 * (`maybeActivateAsync`) performs the rewrite before calling this.
 */
function emitAsyncLane(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.FunctionLikeDeclaration,
  decision: AsyncActivationPlan,
): void {
  switch (decision.lane) {
    case "drive":
      emitAsyncFrameStateMachine(ctx, fctx, decl, decision.plan);
      return;
    case "cps":
      fctx.asyncCpsActive = true;
      emitAsyncStateMachine(ctx, fctx, decl, decision.plan);
      return;
    case "host-drive":
      emitAsyncFrameStateMachine(ctx, fctx, decl, decision.plan, /*host*/ true);
      return;
  }
}

/**
 * Decide whether `decl` should be lowered to an async state machine, and if so
 * emit it (rewriting the result type to externref and emitting the frame/CPS
 * body). Returns `true` when the async machine was emitted — in which case the
 * caller MUST skip its normal statement-compilation loop, because this helper
 * has already produced the full function body.
 *
 * This is the `compileFunctionBody` (function-declaration) entry point. It stays
 * declaration-only for byte-identity (phase 1). The arrow / function-expression
 * paths use {@link planAsyncClosureActivation} + {@link emitAsyncClosureBody}
 * instead, because the closure signature bakes the `externref` (Promise) result
 * into the lifted func/struct type BEFORE the body is emitted, so a post-hoc
 * `func.typeIdx` rewrite would desync the closure struct's funcref field.
 */
export function maybeActivateAsync(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.FunctionLikeDeclaration,
  func: WasmFunction,
): boolean {
  const isAsync = ctx.asyncFunctions.has(func.name);
  const decision = decideAsyncActivation(ctx, decl, isAsync, /*allowNonDeclaration*/ false);
  if (!decision) return false;

  // The async function returns a Promise object (externref), not the unwrapped
  // value. Rewrite the registered signature's result + fctx before emitting.
  rewriteFuncResultType(ctx, func, { kind: "externref" });
  fctx.returnType = { kind: "externref" };
  emitAsyncLane(ctx, fctx, decl, decision);
  return true;
}

/**
 * (#2957 phase 2) Pure async-activation decision for the arrow / function-
 * expression closure paths (`closures.ts::compileArrowAsClosure`). Unlike
 * {@link maybeActivateAsync} it does NOT gate on `ts.isFunctionDeclaration` and
 * does NOT emit or rewrite anything — the closure path calls this EARLY (before
 * it builds the lifted func type + closure struct) so it can bake the
 * `externref` Promise result into the signature, then calls
 * {@link emitAsyncClosureBody} at the body-compile point. `isAsync` reflects the
 * arrow's `async` modifier.
 */
export function planAsyncClosureActivation(
  ctx: CodegenContext,
  decl: ts.FunctionLikeDeclaration,
  isAsync: boolean,
): AsyncActivationPlan | null {
  const decision = decideAsyncActivation(ctx, decl, isAsync, /*allowNonDeclaration*/ true);
  // (#2865) Exception to the phase-2 park below: the for-await-over-async-
  // GENERATOR consumer drive IS validated in the lifted-closure context (its
  // machine is self-contained — every suspension awaits the producer's own
  // `__async_gen_next_*` promise; no continuation capture-struct / `__self`
  // interplay). Without this, an arrow/fn-expr consumer stays legacy while the
  // producer returns the driven frame carrier — the legacy `__iterator` then
  // ref.cast-traps on the frame. Every OTHER drive/host-drive closure shape
  // stays parked (the #2646 33-regression class).
  if (decision !== null && decision.lane === "drive" && asyncGenConsumerNeedsDrive(ctx, decl, decision.plan)) {
    return decision;
  }
  // Phase-2 scope: closures activate ONLY the single-tail-await CPS lane. The
  // host-drive ("host-drive") and native-drive ("drive") lanes activate
  // multi-await / try-finally-across-await shapes whose continuation
  // capture-struct + `__self` handling is NOT yet validated in the lifted-closure
  // context — activating them from the arrow/fn-expr path null_deref'd the
  // async-iteration builtins (Array.fromAsync / await-using /
  // AsyncFromSyncIteratorPrototype / AsyncDisposableStack), whose test262
  // `asyncTest(async function () { …multi-await… })` harness callbacks are
  // multi-await function expressions (33 merge_group regressions on the first
  // #2646 attempt). Those richer closure shapes stay on the legacy path; the
  // drive lanes for closures are a follow-up that needs closure-context
  // validation. The single-tail-await CPS shape (the phase-2 target, e.g.
  // `async (x) => await g(x)`) is unaffected.
  if (decision === null || decision.lane !== "cps") return null;

  // (#2957 phase-2 re-park fix) DISCARDED-TAIL-AWAIT guard for the closure path.
  //
  // The `lane === "cps"` restriction (346e281, first-park fix) was necessary but
  // NOT sufficient. `asyncFnNeedsCps` accepts three single-tail-await shapes
  // (`splitBodyAtAwait`):
  //   1. `return await P` / concise `=> await P`   (`isReturnAwait`)
  //   2. `const x = await P; …suffix`              (`resumeBinding !== null`)
  //   3. `await P; …suffix`                        (bare expression statement)
  // In the lifted-closure context, shapes 1 and 2 — and shape 3 WITH a non-empty
  // suffix — emit a closure that correctly returns its result Promise. But shape
  // 3 with an EMPTY suffix (a bare `await P;` at the tail, whose resolved value is
  // discarded and the function implicitly returns `undefined`) emits a lifted
  // closure that returns `null` instead of a Promise. The test262
  // `asyncTest(async function () { … await assert.throwsAsync(…); })` harness
  // callbacks are exactly this discarded-tail-await shape, so the harness's
  // `testFunc().then(…)` dereferences null — the SECOND merge_group re-park of
  // #2646: 23 pass→null_deref regressions across Array.fromAsync (×15),
  // await-using (×7) and AsyncFromSyncIteratorPrototype (×1).
  //
  // Measured discriminator (host lane, this branch): a bare tail `await P;` with
  // empty suffix returns `null` REGARDLESS of prefix or awaited-operand kind,
  // whereas `const x = await P` (shape 2, even with a rich prefix — the 36
  // Array.fromAsync `const out = await Array.fromAsync(…); assert(…)` test262
  // IMPROVEMENTS) and `await P; return N` (shape 3 WITH suffix — an
  // `issue-2957.test.ts` case) both return a real Promise. So the guard keys on
  // the DISCARD (`!isReturnAwait && resumeBinding === null && suffix.length === 0`),
  // NOT on the prefix: an empty-prefix guard would wrongly revert the rich-prefix
  // `const out = await …` improvements to the (failing) legacy path.
  //
  // Rejecting only the discarded-tail shape banks every value-producing closure
  // shape (all 7 `issue-2957.test.ts` cases + the 36 improvements) and reverts the
  // 23 discarded-tail regressions to their (passing) legacy path. Why the emitted
  // closure returns null for the discard shape specifically is the follow-up: the
  // continuation's empty (undefined-returning) body does not leave the chained
  // result Promise as the lifted closure's return value. Fixing that emit is
  // phase-3 scope; until then the discard shape stays on legacy.
  //
  // NOTE: closure-path-only (`planAsyncClosureActivation`). The function-
  // DECLARATION entry (`maybeActivateAsync`) is unchanged — declarations are not
  // lifted into a closure struct, so the discard shape emits correctly there and
  // the decl CPS lane keeps full single-tail-await support (byte-identity).
  const split = splitBodyAtAwait(decl, decision.plan);
  if (split === null) return null;

  // Reject the two UNSAFE bare-`await P;` (shape 3, no binding, not a
  // `return await`) closure sub-shapes. Both emit a lifted closure whose result
  // is wrong; every other single-tail-await shape is validated safe.
  //
  //  (a) EMPTY suffix — a discarded tail `await P;` (implicit `undefined` return).
  //      The lifted closure returns `null` instead of its result Promise, so the
  //      test262 `asyncTest(async () => { … await assert.throwsAsync(…); })`
  //      harness null_derefs at `testFunc().then(…)`. This is 22 of the 23
  //      re-park regressions (Array.fromAsync error-path + await-using).
  //
  //  (b) VALUE-RETURN suffix — a bare `await P; … return Q;` where the
  //      continuation returns a value (esp. an async-adopted promise, e.g.
  //      `await it.next(); return it.throw(e)` in the AsyncFromSyncIterator
  //      throw-null nested arrow, the 23rd regression, an assertion_fail). The
  //      lifted continuation does not adopt `Q`, so the settled value is wrong.
  //
  // Shape 3 WITH a NON-returning suffix (`await P; assert(…)` — the continuation
  // returns void) IS safe and is the shape behind several of the 36 Array.fromAsync
  // / await-using IMPROVEMENTS (`… await Array.fromAsync(input); assert.sameValue(…)`),
  // so it must stay activated. Restricting to (a)+(b) banks all 36 improvements and
  // reverts exactly the 23 regressions to the (passing) legacy path. The one
  // `issue-2957.test.ts` `await P; return N` case moves to legacy too — it still
  // resolves to the correct value there, so the suite stays green.
  const isBareTailAwait = !split.isReturnAwait && split.resumeBinding === null;
  if (isBareTailAwait && (split.suffix.length === 0 || suffixReturnsValue(split.suffix))) return null;
  return decision;
}

/**
 * (#2957 phase-2 re-park fix) True when any statement in a bare-`await` closure's
 * post-await suffix is — or contains at any depth — a `return <expr>`. Such a
 * continuation must settle the result promise with (and, for a thenable,
 * ADOPT) that value; the lifted-closure CPS emit does not, so the settled value
 * is wrong (the AsyncFromSyncIterator throw-null regression). A `return;` with no
 * argument is void and does not trigger this.
 */
function suffixReturnsValue(suffix: readonly ts.Statement[]): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // Do not descend into nested function-likes: their `return` belongs to a
    // different frame, not this continuation.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const stmt of suffix) visit(stmt);
  return found;
}

/**
 * (#2957 phase 2) Emit a decided async lane into the lifted closure body. The
 * closure path has already baked `externref` into the lifted func/struct type
 * (via the `computeClosureWrapperSig` override), so — unlike the declaration
 * entry — there is no result-type rewrite here. `fctx.returnType` must already
 * be `externref`.
 */
export function emitAsyncClosureBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.FunctionLikeDeclaration,
  decision: AsyncActivationPlan,
): void {
  emitAsyncLane(ctx, fctx, decl, decision);
}
