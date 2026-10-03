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
import { reportError } from "./context/errors.js";
import type { AsyncCpsPlan } from "./async-cps.js";
import { ASYNC_CPS_ENABLED, analyzeAsyncBody } from "./async-cps.js";
import {
  emitAsyncFrameStateMachine,
  asyncFnNeedsDrive,
  asyncFnNeedsHostDrive,
  asyncGenConsumerNeedsDrive,
} from "./async-frame.js";
import { isStandalonePromiseActive } from "./async-scheduler.js";
import { widenAsyncThenableResults } from "./async-thenable-return.js";

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
 *  - `host-drive` — JS-host N-state resume machine (host settle backend).
 * (#2967 2c) The legacy `cps` lane (`emitAsyncStateMachine`) is DELETED — the
 * frame engine claims its entire population (slices 1/2a/2b + phases 3a/3b);
 * #3134's Promise<T> value-slot rep fix removed the last class-2 re-lane.
 */
export type AsyncLane = "drive" | "host-drive";

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
    // (#2967 slices 1/2/3 — ONE engine) The #2906 N-state resume machine
    // (host settle backend) claims every linear shape it can drive. The legacy
    // CPS arm that used to sit behind it is DELETED: after slice 2b (concise
    // arrows + pattern params), phase 3a (cell-aware frame fields) and #3134
    // (Promise<T> value-slot rep), `asyncFnNeedsHostDrive` accepts the full
    // single-tail-await population + the former class-2 closures, so the CPS
    // fallback was unreachable. One engine, two settle backends.
    if (asyncFnNeedsHostDrive(ctx, decl, asyncPlan)) return { lane: "host-drive", plan: asyncPlan };
  }

  return null;
}

/**
 * (#1373b C-1) Pure activation PREDICATE for the IR selector: would the ONE
 * async engine (drive / host-drive frame machine) claim this async function
 * declaration? Decision-only — no emission, no signature rewrite.
 *
 * The IR path claims an async function IFF the engine declines it (the legacy
 * synchronous pass-through population). This predicate is the engine side of
 * that invariant, threaded into `planIrCompilation` as
 * `IrSelectionOptions.asyncEngineClaims` so engine-activated functions keep
 * byte-identical routing while IR takes over the sync-model residue. Keep it
 * in lockstep with `maybeActivateAsync` (same `allowNonDeclaration: false`
 * gating — C-1 claims FunctionDeclarations only; #2957's closure shapes stay
 * on their own activation path).
 *
 * (#3587/#6780) On a decline this ALSO runs the loud-refusal guards
 * ({@link reportDeclinedAsyncBody}): a declined-but-rejection-observing shape,
 * or a declined body of only settled awaits, must not silently proceed on
 * EITHER downstream lane (legacy sync pass-through or IR C-1 — both compile
 * `await` as a synchronous pass-through that neither delivers rejections nor
 * yields a microtask turn). Deduped per declaration, so the later
 * `maybeActivateAsync` call cannot double-report.
 */
export function asyncEngineWouldActivate(ctx: CodegenContext, decl: ts.FunctionLikeDeclaration): boolean {
  const claimed = decideAsyncActivation(ctx, decl, /*isAsync*/ true, /*allowNonDeclaration*/ false) !== null;
  if (!claimed && ts.isFunctionDeclaration(decl)) reportDeclinedAsyncBody(ctx, decl);
  return claimed;
}

// ── (#3587) Loud refusal: declined shapes must not silently swallow rejections ──
//
// Any async body with a REAL (non-statically-resolved) suspension that the
// engine declines falls to a synchronous pass-through — legacy or IR C-1 —
// where an awaited REJECTION does not throw: execution continues straight past
// the rejected await, `catch` blocks never run, and the rejection leaks as an
// unhandledRejection. That is tolerable-by-bug-compatibility for code that
// never observes rejections, but it is a guaranteed-silent-miscompile for a
// body whose author wrapped a suspension in `try` — the very construct that
// signals "I care about this rejection" was what disabled rejection delivery.
//
// Rule: a declined async FunctionDeclaration / arrow / function-expression
// (the engine's claimable entry points) with a real suspension lexically
// inside a `try` block refuses loudly with a source-located compile error
// instead of silently mis-executing. Async METHODS are excluded for now: the
// engine cannot claim them at any shape yet (#2957 phase-3 residue), so a
// guard there would refuse the entire population rather than a residue —
// tracked in the #3587 issue file as remaining surface.

/** Per-context dedupe so the selector probe + activation path report once. */
const hazardReportedByCtx = new WeakMap<CodegenContext, WeakSet<ts.Node>>();

function isNestedFunctionScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * First suspension point (`await` or `for await`) lexically inside the TRY
 * block of a `try` statement in `decl`'s own body (not crossing nested
 * function scopes), or `null`. Awaits inside `catch`/`finally` blocks only
 * count when an ENCLOSING `try` block wraps them.
 */
function findSuspensionInsideTry(decl: ts.FunctionLikeDeclaration): ts.Node | null {
  const body = decl.body;
  if (body === undefined) return null;
  let found: ts.Node | null = null;
  const walk = (node: ts.Node, inTry: boolean): void => {
    if (found !== null || isNestedFunctionScope(node)) return;
    if (inTry && (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier !== undefined))) {
      found = node;
      return;
    }
    if (ts.isTryStatement(node)) {
      walk(node.tryBlock, true);
      if (node.catchClause) walk(node.catchClause.block, inTry);
      if (node.finallyBlock) walk(node.finallyBlock, inTry);
      return;
    }
    ts.forEachChild(node, (c) => walk(c, inTry));
  };
  ts.forEachChild(body, (c) => walk(c, false));
  return found;
}

/**
 * (#3587) Report the loud-refusal compile error for a declined async
 * function-like whose body genuinely suspends inside a `try`. HOST lane only:
 * the wasi/standalone drive lanes have their own claim/decline programs
 * (#2865/#2867/#2980) and their declined populations are tracked there.
 * No-op when the body cannot really suspend (statically-resolved awaits
 * cannot reject) or when no suspension sits inside a `try`.
 */
function reportDeclinedAsyncRejectionHazard(ctx: CodegenContext, decl: ts.FunctionLikeDeclaration): void {
  if (!ASYNC_CPS_ENABLED || decl.body === undefined) return;
  if (ctx.wasi === true || ctx.standalone === true) return;
  const seen = hazardReportedByCtx.get(ctx);
  if (seen?.has(decl)) return;
  const plan = analyzeAsyncBody(ctx, decl);
  const realSuspension = plan.awaitPoints.some((a) => plan.awaitedStaticallyResolved.get(a) !== true);
  if (!realSuspension && plan.forAwaitPoints.length === 0) return;
  // (#6504 round 30) The `try`-scoped condition is LOAD-BEARING, not a
  // conservative placeholder. Dropping it — refusing loudly for every decline
  // with a real suspension — was measured on the six async slices (linked) and
  // costs **402 of 2,212 rows**, 396 of them `statements/for-await-of`
  // destructuring shapes that the engine declines and the sync fallback runs
  // acceptably today. That is 20x the >= 20-row budget the widening was gated
  // on, so it is not a tuning question: the declined-with-real-suspension
  // population is most of the for-await-of corpus, and turning it into compile
  // errors trades a latent rejection bug for 402 certain failures. Any future
  // widening has to name a SUBSET (e.g. by decline reason), never the whole
  // population.
  const hazard = findSuspensionInsideTry(decl);
  if (hazard === null) return;
  if (seen === undefined) hazardReportedByCtx.set(ctx, new WeakSet([decl]));
  else seen.add(decl);
  reportError(
    ctx,
    hazard,
    "async shape not supported: this suspension point (await / for-await) sits inside a `try` " +
      "whose overall body shape the async engine cannot drive yet, and the synchronous fallback " +
      "would SILENTLY drop awaited rejections (execution would continue past a rejected await; " +
      "catch/finally would not run). Restructure toward canonical awaits — top-level " +
      "`await p` / `const x = await p` / `return await p` statements, try/catch(/finally) " +
      "without awaits in loops/conditions inside the try — or hoist the await out of the try (#3587)",
  );
}

// ── (#6780) Loud refusal: a declined body must not elide `await <settled>` ──
//
// `await null` / `await 1` / `await Promise.resolve()` still yields one
// microtask turn (§27.7.5.3): the code after the CALL SITE runs before the
// continuation. The host engine therefore claims such bodies like any other
// (`asyncFnNeedsHostDrive` has no all-static decline). A body it still declines
// is declined for its SHAPE (e.g. an await inside a loop), and the synchronous
// pass-through would run every continuation inline — a silent reordering, so
// refuse instead.
//
// Scope is a NAMED SUBSET, as #6504 round 30 requires of any widening: host
// lane only; only bodies with no real suspension (real-suspension declines
// stay on the #3587 `try`-scoped guard above); and only the engine's own
// claimable entry points — top-level declarations, arrows and function
// expressions. Nested declarations (policy-declined in
// nested-declarations.ts) and methods (#2957) run the pass-through for REAL
// awaits too; refusing only their settled awaits would refuse a population the
// engine never claims at any operand.

const staticDeclineReportedByCtx = new WeakMap<CodegenContext, WeakSet<ts.Node>>();

function isHostDriveLane(ctx: CodegenContext): boolean {
  return ctx.wasi !== true && ctx.standalone !== true && !isStandalonePromiseActive(ctx);
}

function isEngineEntryPoint(decl: ts.FunctionLikeDeclaration): boolean {
  if (ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) return true;
  return ts.isFunctionDeclaration(decl) && ts.isSourceFile(decl.parent);
}

/** First await of a declined host body whose every await is settled, else `null`. */
function findElidedSettledAwait(ctx: CodegenContext, decl: ts.FunctionLikeDeclaration): ts.AwaitExpression | null {
  if (!ASYNC_CPS_ENABLED || decl.body === undefined || !isHostDriveLane(ctx)) return null;
  if (!isEngineEntryPoint(decl) || decl.asteriskToken !== undefined) return null;
  const plan = analyzeAsyncBody(ctx, decl);
  if (plan.awaitPoints.length === 0 || plan.forAwaitPoints.length > 0) return null;
  if (plan.awaitPoints.some((a) => plan.awaitedStaticallyResolved.get(a) !== true)) return null;
  return plan.awaitPoints[0]!;
}

function reportDeclinedSettledAwaitBody(ctx: CodegenContext, decl: ts.FunctionLikeDeclaration): void {
  const seen = staticDeclineReportedByCtx.get(ctx);
  if (seen?.has(decl)) return;
  const elided = findElidedSettledAwait(ctx, decl);
  if (elided === null) return;
  if (seen === undefined) staticDeclineReportedByCtx.set(ctx, new WeakSet([decl]));
  else seen.add(decl);
  reportError(
    ctx,
    elided,
    "async shape not supported: this `await` has an already-settled operand, but the body's " +
      "control flow (e.g. an await inside a loop) is a shape the async engine cannot drive yet, " +
      "and the synchronous fallback would run the continuation BEFORE the caller resumes (an " +
      "`await` always yields a microtask turn, whatever its operand). Restructure toward canonical " +
      "awaits — top-level `await x` / `const v = await x` / `return await x` statements, awaits " +
      "inside if/try — or hoist the await out of the loop (#6780)",
  );
}

/**
 * Decline-side guards for an async function-like the engine did NOT claim
 * (#3587 rejection hazard + #6780 elided settled awaits). Each is
 * self-scoping and deduped per declaration, so the IR-selector probe and the
 * body-compile path may both call this.
 */
export function reportDeclinedAsyncBody(ctx: CodegenContext, decl: ts.FunctionLikeDeclaration): void {
  reportDeclinedAsyncRejectionHazard(ctx, decl);
  reportDeclinedSettledAwaitBody(ctx, decl);
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
  if (!decision) {
    // (#3587/#6780) A declined-but-rejection-observing (or settled-await-only)
    // declaration must refuse loudly rather than fall to the sync pass-through.
    if (isAsync && ts.isFunctionDeclaration(decl)) reportDeclinedAsyncBody(ctx, decl);
    return false;
  }

  // The async function returns a Promise object (externref), not the unwrapped
  // value. Rewrite the registered signature's result + fctx before emitting.
  rewriteFuncResultType(ctx, func, { kind: "externref" });
  fctx.returnType = { kind: "externref" };
  emitAsyncLane(ctx, fctx, decl, decision);
  return true;
}

/**
 * Declaration-time wasm result for a top-level function declaration: the
 * #5371 thenable widening, then (#6780) the Promise carrier for an async
 * declaration the HOST engine will drive.
 *
 * {@link maybeActivateAsync} rewrites a driven declaration's result to
 * `externref` only when its BODY compiles. A caller compiled earlier — a
 * forward reference, e.g. `main` declared above its helpers — had already
 * baked the unwrapped `T`, and the stack repair then unboxed the returned
 * Promise to NaN (`await helper()` read NaN). #6780 put every
 * settled-await body on the engine, so this registers the carrier the body
 * will produce up front, making call sites order-independent. Host lane only
 * (the wasi/standalone drive lane keys its call sites on `calleeIsDriveLowered`
 * instead); same decision as the activation itself, so the two cannot drift.
 */
export function widenAsyncDeclarationResults(
  ctx: CodegenContext,
  decl: ts.FunctionDeclaration,
  results: ValType[],
): ValType[] {
  const widened = widenAsyncThenableResults(ctx, decl, results);
  if (!ts.isSourceFile(decl.parent) || decl.asteriskToken !== undefined || !isHostDriveLane(ctx)) return widened;
  if (widened.length === 1 && widened[0]!.kind === "externref") return widened;
  const isAsync = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true;
  if (decideAsyncActivation(ctx, decl, isAsync, /*allowNonDeclaration*/ false)?.lane !== "host-drive") return widened;
  return [{ kind: "externref" }];
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
  // (#2967 slices 2a/2c) HOST-DRIVE closures are ADMITTED directly — the whole
  // former CPS re-lane is gone. The #2646 park (33 null_deref regressions) was
  // resolved by the #2865 resume-fn environment re-establishment
  // (`ensureAsyncResumeFunction` re-runs the `__self` capture-struct
  // materialization, threads capture-CELL deref routing + `readsCurrentThis`);
  // the #2873 class-1 cell hazard by phase 3a's force-boxed cell fields; and
  // the last class-2 (ref-typed spill-guess) hazard by #3134's Promise<T>
  // value-slot rep fix (the guess now matches the stored promise —
  // measured: the fromAsync class-2 corpus drives with 0 regressions,
  // +1 improvement). The 2957-era discarded-tail/value-return-suffix guards
  // were CPS-EMIT bugs (the lifted CPS continuation lost the result promise) —
  // the frame engine settles the pre-allocated result promise uniformly in the
  // dispatch loop, so those shapes are simply correct on it. The native
  // `drive` lane stays gated on the asyncGen-consumer exception above.
  if (decision !== null && decision.lane === "host-drive") return decision;
  return null;
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
