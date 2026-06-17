// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Async/await CPS (continuation-passing-style) lowering — module skeleton (#1042).
//
// This is the shared analysis + emission surface that both the AST path (#1042)
// and the IR path (#1373b) call into to turn an `async function` body into a
// generator-style state machine: split at each `await`, compile each segment as
// a continuation, chain them via Promise.then.
//
// PR1 scope (this commit): the SURFACE only.
//   - `analyzeAsyncBody` is real and pure — it walks the body, finds await
//     points, and computes the live-local set carried across each await. No
//     codegen side effects. This is what the tests exercise.
//   - `emitAsyncStateMachine` / `compileNestedAwait` are present but inert:
//     the activation hook in function-body.ts is NOT wired in this PR, and the
//     `asyncCpsActive` gate (see ASYNC_CPS_ENABLED) is hardcoded false, so the
//     emit path is never reached. Emitted Wasm is byte-identical to before —
//     same inert-first pattern as #1586 (alloc sites) and #1587 (ownership).
//   - `emitAsyncStateMachineFromIr` is a stub returning false (#1373b fills it).
//
// The full lowering (segment emission, capture structs, Promise.then chaining)
// lands in follow-up PRs. See plan/issues/backlog/1042-async-await-state-machine-lowering.md.

import { ts, forEachChild } from "../ts-api.js";
import { reportError } from "./context/errors.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { Instr, ValType } from "../ir/types.js";
import {
  collectReferencedIdentifiers,
  collectBindingPatternNames,
  compileSyntheticAsyncContinuation,
  type AsyncCapture,
} from "./closures.js";
import { compileExpression, compileStatement, coerceType } from "./shared.js";
import { allocLocal } from "./context/locals.js";
import { resolveWasmType } from "./index.js";
import { isPromiseType } from "../checker/type-mapper.js";

/**
 * Master gate for the AST-side async CPS lowering.
 *
 * Slice 2A (#1042) built the linear single-tail-await state machine and made it
 * *correct when it runs*: the canonical shapes resolve to the right value
 * through `Promise_resolve` → `Promise_then2` → continuation, captures and the
 * `return await` identity tail are handled, and the late-import shift hazard is
 * removed by the `collectAsyncCpsImports` prepass.
 *
 * Flipped **ON** in #1796. The synchronous-consumption regression that kept it
 * off is resolved by the per-function {@link asyncFnNeedsCps} predicate (#1936):
 * an async fn is CPS-lowered (returns a real Promise) ONLY when it *genuinely
 * suspends* — at least one await operand is not statically resolved. Fully
 * await-elidable bodies (`return await Promise.resolve(42)`, `await 41; ...`)
 * stay on the legacy synchronous path and keep returning the unwrapped value, so
 * the `asyncFn() as any as number` "compile away" idiom (#1313/#1727) is
 * preserved for those. Functions that truly suspend now return a real Promise;
 * call sites that consume such a result as a raw value cannot be served
 * synchronously by construction and were already semantically broken under the
 * legacy fakery — those test cases are migrated to the Promise model in #1796.
 */
export const ASYNC_CPS_ENABLED = true;

/**
 * Result of analysing an async function body for the CPS transform.
 * Populated by {@link analyzeAsyncBody}, consumed by {@link emitAsyncStateMachine}.
 */
export interface AsyncCpsPlan {
  /** Pre-order list of await points found in the body (by `ts.Node` identity). */
  readonly awaitPoints: readonly ts.AwaitExpression[];
  /**
   * For each await point: the set of live local names that must be captured
   * into the continuation that resumes after the await. "Live" = referenced in
   * any statement/expression that executes after the await point.
   */
  readonly liveAfterAwait: ReadonlyMap<ts.AwaitExpression, ReadonlySet<string>>;
  /** Does the body contain a `try`/`catch` that spans an await? (Phase 3B — gated.) */
  readonly hasTryAcrossAwait: boolean;
  /** Does the body contain a `throw` that must reject the outer Promise? */
  readonly hasUncaughtThrow: boolean;
  /**
   * For each await point: `true` when its operand is *statically resolved* —
   * i.e. the awaited value is already settled at compile time and the suspension
   * is observably a no-op (`await 1`, `await Promise.resolve(x)`, `await` over a
   * literal/arithmetic-of-literals). When EVERY await in a body is statically
   * resolved (and the body otherwise matches a CPS-able shape), the function does
   * not genuinely suspend: it can be compiled as a synchronous function that
   * returns a fulfilled Promise (compile-time await-elision) instead of paying
   * the CPS state-machine cost. See {@link asyncFnNeedsCps} (#1936).
   *
   * Conservative: only the forms enumerated in {@link awaitIsStaticallyResolved}
   * count as resolved; anything else (a call result, a member read, an
   * identifier that might hold a pending Promise) is `false` so the safe CPS /
   * legacy path is chosen.
   */
  readonly awaitedStaticallyResolved: ReadonlyMap<ts.AwaitExpression, boolean>;
}

/**
 * Walk the body of an async function / arrow / method and produce a plan.
 *
 * Pure analysis — no codegen side effects, no `ctx`/`fctx` mutation. Safe to
 * call speculatively (the function-body hook calls it to decide whether a
 * function needs CPS at all: zero await points ⇒ legacy path).
 */
export function analyzeAsyncBody(_ctx: CodegenContext, fn: ts.FunctionLikeDeclaration): AsyncCpsPlan {
  const awaitPoints: ts.AwaitExpression[] = [];
  const body = fn.body;

  // Collect await points in pre-order, WITHOUT descending into nested function
  // scopes — a nested `async` function/arrow has its own state machine and its
  // awaits do not suspend the enclosing function.
  if (body !== undefined) {
    collectAwaitPoints(body, awaitPoints);
  }

  // Live-after-await: for each await, the names referenced in the textual
  // remainder of the body. PR1 uses a conservative whole-remainder
  // approximation (everything that lexically follows the await). Precise
  // segment-based liveness is refined in the lowering PR; over-approximation is
  // safe (we capture a superset, never miss a live local).
  //
  // NOTE: we collect ALL declared names — params + var + let + const — not just
  // function-scoped vars. `collectFunctionOwnLocals` deliberately skips let/const
  // (block-scoped, irrelevant to closure var-hoisting), but for CPS a let/const
  // declared before an await and read after it MUST be carried into the
  // continuation, so we need the full set.
  const ownLocals = new Set<string>();
  collectAllDeclaredNames(fn, ownLocals);

  const liveAfterAwait = new Map<ts.AwaitExpression, ReadonlySet<string>>();
  for (const awaitExpr of awaitPoints) {
    const referencedAfter = new Set<string>();
    collectReferencedAfter(body!, awaitExpr, referencedAfter);
    // Keep only names that are params/locals of THIS function — globals and
    // imports don't need capturing.
    const live = new Set<string>();
    for (const name of referencedAfter) {
      if (ownLocals.has(name)) live.add(name);
    }
    liveAfterAwait.set(awaitExpr, live);
  }

  // Static-resolution census (#1936): classify each await operand as
  // settled-at-compile-time or not. Drives `asyncFnNeedsCps` and the
  // compile-time await-elision decision in #1796.
  const awaitedStaticallyResolved = new Map<ts.AwaitExpression, boolean>();
  for (const awaitExpr of awaitPoints) {
    awaitedStaticallyResolved.set(awaitExpr, awaitIsStaticallyResolved(awaitExpr.expression));
  }

  return {
    awaitPoints,
    liveAfterAwait,
    hasTryAcrossAwait: awaitPoints.length > 0 && bodyHasTryAcrossAwait(body),
    hasUncaughtThrow: body !== undefined && bodyHasUncaughtThrow(body),
    awaitedStaticallyResolved,
  };
}

/**
 * Conservative compile-time predicate: is the operand of an `await` already a
 * *settled* value, so that `await operand` performs no observable suspension?
 *
 * Per §27.7.5.3, `await V` ≡ `PromiseResolve(%Promise%, V)` then a job. When `V`
 * is not a thenable the resumption is a single microtask carrying `V` unchanged;
 * when `V` is `Promise.resolve(x)` with a non-thenable `x` it likewise settles
 * to `x`. In both cases the *value* is statically known to be the operand (or
 * its resolve-argument); only the scheduling differs. js2wasm's synchronous
 * model already collapses that scheduling, so these awaits are safe to treat as
 * pass-through.
 *
 * Recognised static forms (intentionally narrow — over-approximating here would
 * mis-elide a genuinely-suspending await):
 *   - numeric / string / boolean / null literals
 *   - `void`-prefixed, unary `+`/`-`/`!` over a static operand
 *   - binary arithmetic / comparison where BOTH operands are static
 *   - parenthesised / `as`-cast wrappers around a static operand
 *   - `Promise.resolve(<static>)` and `Promise.resolve()` (settles to undefined)
 *
 * Everything else — a call result, a member access, a bare identifier (which may
 * hold a pending Promise) — returns `false`.
 */
export function awaitIsStaticallyResolved(operand: ts.Expression): boolean {
  // Unwrap transparent wrappers first.
  let expr: ts.Expression = operand;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = expr.expression;
  }

  // Literals: numeric / string / no-substitution template / true / false / null.
  if (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteral(expr) ||
    ts.isNoSubstitutionTemplateLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }

  // `undefined` as an identifier is a settled value too.
  if (ts.isIdentifier(expr) && expr.text === "undefined") return true;

  // Unary `+x` / `-x` / `!x` / `void x` over a static operand.
  if (ts.isPrefixUnaryExpression(expr)) {
    return awaitIsStaticallyResolved(expr.operand);
  }
  if (ts.isVoidExpression(expr)) {
    return awaitIsStaticallyResolved(expr.expression);
  }

  // Binary arithmetic/comparison where both sides are static.
  if (ts.isBinaryExpression(expr)) {
    return awaitIsStaticallyResolved(expr.left) && awaitIsStaticallyResolved(expr.right);
  }

  // `Promise.resolve(<static?>)` — settles to the (static) argument, or undefined.
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Promise" &&
    expr.expression.name.text === "resolve"
  ) {
    if (expr.arguments.length === 0) return true; // resolves to undefined
    if (expr.arguments.length === 1) return awaitIsStaticallyResolved(expr.arguments[0]!);
    return false;
  }

  return false;
}

/** Promise static combinators whose call result is already a real Promise. */
const PROMISE_COMBINATOR_NAMES = new Set(["all", "race", "any", "allSettled"]);

/**
 * Is `operand` a `Promise.<combinator>(...)` call (`Promise.all`, `Promise.race`,
 * `Promise.any`, `Promise.allSettled`)? Such an operand is *already* a real
 * Promise, so `await` over it gains nothing from the CPS state machine: the
 * legacy path (`await`-is-identity over a combinator that returns a real
 * Promise) already produces a correct result Promise. Keeping these on the
 * legacy path also sidesteps the host `declare`-class-method argument marshaling
 * gap (e.g. `Promise.all(src.getPromises())`) that #2028 owns — the CPS awaited
 * expression would otherwise mis-marshal the host-method argument. (#1796)
 */
function awaitedExprIsPromiseCombinator(operand: ts.Expression): boolean {
  let expr: ts.Expression = operand;
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = expr.expression;
  }
  return (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Promise" &&
    PROMISE_COMBINATOR_NAMES.has(expr.expression.name.text)
  );
}

/**
 * The per-function CPS decision (#1936) — replaces the global
 * {@link ASYNC_CPS_ENABLED} kill-switch with a per-function predicate. Returns
 * `true` only when the function *genuinely suspends* and the suspension is in a
 * shape the state machine can lower:
 *
 *   1. at least one await point exists,
 *   2. at least one await operand is NOT statically resolved (a real suspension —
 *      otherwise the body is await-elidable and compiles as a sync fn returning
 *      a fulfilled Promise), and
 *   3. {@link splitBodyAtAwait} accepts the body shape (single top-level await in
 *      a canonical position; richer control flow stays on the legacy path with a
 *      `cps-unsupported-shape` census bucket), and
 *   4. the single awaited operand is not a `Promise.<combinator>(...)` call —
 *      those already return a real Promise that the legacy `await`-identity path
 *      resolves correctly, and routing them through CPS regresses host-method
 *      argument marshaling pending #2028 (see {@link awaitedExprIsPromiseCombinator}).
 *
 * `ASYNC_CPS_ENABLED` is retained as a transitional master kill-switch routed
 * through this predicate; when it is `false` the predicate always returns
 * `false` (the pre-#1796 shipped behaviour).
 */
export function asyncFnNeedsCps(fn: ts.FunctionLikeDeclaration, plan: AsyncCpsPlan): boolean {
  if (!ASYNC_CPS_ENABLED) return false;
  if (plan.awaitPoints.length === 0) return false;
  const anyRealSuspension = plan.awaitPoints.some((a) => plan.awaitedStaticallyResolved.get(a) !== true);
  if (!anyRealSuspension) return false; // fully await-elidable → sync + resolved Promise
  const split = splitBodyAtAwait(fn, plan);
  if (split === null) return false;
  if (awaitedExprIsPromiseCombinator(split.awaitedExpr)) return false; // already a real Promise
  return true;
}

/**
 * Classification of how an async call's result is consumed at its call site —
 * the per-call-site half of the async contract migration (#1936). The legacy
 * boolean `asyncResultConsumedAsValue` only distinguished "raw value" from
 * "everything else"; the census needs the three-way split so #1796 can migrate
 * exactly the `value`-but-not-statically-resolved set.
 *
 *   - `await`    — consumed by an enclosing `await` (raw-T passthrough today).
 *   - `value`    — consumed through a non-Promise cast/assertion sink
 *                  (`f() as number`, `as unknown as number`, `as any`): the
 *                  synchronous-consumption contract that blocks the global flip.
 *   - `thenable` — consumed as a real Promise (`.then`, `Promise.all([f()])`,
 *                  `const p: Promise<T> = f()`, bare `return f()`): already
 *                  spec-correct, takes the wrap path.
 */
export type AsyncConsumerKind = "await" | "value" | "thenable";

/**
 * Census classifier for an async call result's consumer (#1936). Pure: depends
 * only on the AST shape around `expr` and the `checker` for cast target types,
 * so the offline census script can reuse it without a full `CodegenContext`.
 *
 * Walks the transparent wrapper chain (`(...)`, `as`, `!`, `<T>`) from
 * `expr.parent` exactly as the shipped `asyncResultConsumedAsValue` does, then:
 *   - if the semantic consumer is an `AwaitExpression` → `await`,
 *   - else if any wrapper cast targets a non-Promise type → `value`,
 *   - else → `thenable`.
 *
 * Behaviour parity note: `classifyAsyncConsumer(...) !== "thenable"` is exactly
 * the boolean the legacy `asyncResultConsumedAsValue` returns, so routing the
 * call site through this classifier is a behaviour-preserving refactor until the
 * #1796 flip changes the `value`/`thenable` dispatch.
 */
export function classifyAsyncConsumer(checker: ts.TypeChecker, expr: ts.CallExpression): AsyncConsumerKind {
  let sawNonPromiseCast = false;
  let parent: ts.Node | undefined = expr.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isTypeAssertionExpression(parent))
  ) {
    if (ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent)) {
      const castType = checker.getTypeAtLocation(parent);
      if (!isPromiseType(castType)) sawNonPromiseCast = true;
    }
    parent = parent.parent;
  }
  if (parent && ts.isAwaitExpression(parent)) return "await";
  return sawNonPromiseCast ? "value" : "thenable";
}

/**
 * Emit a CPS-lowered async function body into `fctx`, replacing the normal
 * statement loop. Drives the entire body and leaves the result Promise
 * (externref) on the stack as the function's return value; the caller skips
 * its own statement loop.
 *
 * PR1 scope — a single tail-position await in one of the canonical shapes
 * (`return await P`, `const x = await P; rest`, `await P; rest`). The
 * function result type must already have been rewritten to `externref` by the
 * activation hook (the function returns a Promise object, not the unwrapped
 * value). Everything is gated behind {@link ASYNC_CPS_ENABLED} + the
 * function-body activation gate, so this never runs in default compilation
 * until that gate is flipped.
 *
 * Strategy (no funcref table, no manual settle):
 *   1. Emit the synchronous prefix into `fctx`.
 *   2. Compile the awaited expression → externref (the promise we suspend on).
 *   3. Synthesize an exported `__cb_N(captures, awaitValue) -> externref`
 *      continuation whose body is the post-await suffix; its `return X`
 *      naturally produces `X` as the cb's externref result.
 *   4. At the suspension point emit the creation site:
 *        push cbId; build+push captures struct; `__make_callback` → contCb;
 *        `Promise_then2(awaited, contCb, null)` → the chained result Promise.
 *      `.then`'s own returned promise resolves to the continuation's return
 *      value, so it IS this async function's result promise. A null reject
 *      callback lets rejections propagate (default rethrow).
 *
 * Returns nothing; on an unsupported shape it `reportError`s and leaves the
 * caller to fall back (the activation hook only calls this for shapes
 * `splitBodyAtAwait` accepts, so that path is defensive).
 */
export function emitAsyncStateMachine(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fn: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): void {
  const split = splitBodyAtAwait(fn, plan);
  if (split === null) {
    reportError(ctx, fn, "internal: async CPS activated on an unsupported body shape (#1042 PR1)");
    return;
  }

  // 1. Synchronous prefix — runs before suspension, in the outer frame.
  for (const stmt of split.prefix) compileStatement(ctx, fctx, stmt);

  // Resolve the three host imports the driver emits. All are pre-registered by
  // the `collectAsyncCpsImports` prepass (index.ts) when the gate is on and a
  // CPS-eligible async fn exists, so they carry STABLE funcMap indices — never
  // `ensureLateImport` here. The outer `$f` body is not in `ctx.liveBodies`
  // during this emission, so a late import added mid-body would not have its
  // `call` opcodes shifted (the classic #1384 hazard); the prepass removes that
  // hazard at its source. See #1042 "Slice 2A runtime-validated blockers".
  const resolveIdx = ctx.funcMap.get("Promise_resolve");
  const makeCbIdx = ctx.funcMap.get("__make_callback");
  const then2Idx = ctx.funcMap.get("Promise_then2");
  if (resolveIdx === undefined || makeCbIdx === undefined || then2Idx === undefined) {
    reportError(
      ctx,
      fn,
      "internal: async CPS imports not pre-registered (collectAsyncCpsImports prepass missing) (#1042)",
    );
    return;
  }

  // 2. Awaited expression → externref, then `Promise.resolve(V)` so the value
  //    is always a real promise. `await V` is `PromiseResolve(%Promise%, V)`
  //    (§27.7.5.3): a thenable/promise passes through unchanged, a plain value
  //    is wrapped. Without this, `Promise_then2`'s host `p.then(...)` would
  //    throw on a non-thenable awaited value (e.g. `await 99`).
  const awaitedType = compileExpression(ctx, fctx, split.awaitedExpr);
  if (awaitedType !== null && awaitedType !== undefined) {
    coerceType(ctx, fctx, awaitedType as ValType, { kind: "externref" });
  } else {
    // void awaited expression — await undefined; push undefined sentinel.
    fctx.body.push({ op: "ref.null.extern" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: resolveIdx } as Instr);
  // Stash the awaited promise so the continuation-creation site can re-push it
  // after building the captures struct (struct.new consumes stack values).
  const awaitedLocal = allocLocal(fctx, "__awaited", { kind: "externref" });
  fctx.body.push({ op: "local.set", index: awaitedLocal } as Instr);

  // 4. Resume binding (the `const x = await P` binding), if any. Computed
  //    BEFORE captures so its name is excluded from the capture set: the
  //    resume binding does not exist at suspension time (it is assigned from
  //    `__awaitValue` inside the continuation). `hoistLetConstWithTdz` already
  //    allocated a same-named outer local, so `liveAfterAwait` lists it — but
  //    capturing it would snapshot its uninitialized (zero) value and shadow
  //    the real resumed value in the continuation. (#1042 Slice 2A defect.)
  let resumeBinding: { name: string; type: ValType } | null = null;
  if (split.resumeBinding) {
    const t: ValType = split.resumeBinding.type
      ? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(split.resumeBinding.type))
      : { kind: "externref" };
    resumeBinding = { name: split.resumeBinding.name, type: t };
  }

  // 3. Build the capture set: the live locals carried across the await,
  //    excluding the resume binding (bound fresh in the continuation).
  const liveNames = plan.liveAfterAwait.get(plan.awaitPoints[0]!) ?? new Set<string>();
  const captures: AsyncCapture[] = [];
  for (const name of liveNames) {
    if (resumeBinding && name === resumeBinding.name) continue;
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue; // not a real outer local (shouldn't happen — analyzeAsyncBody filters)
    const localDef = fctx.locals[localIdx - fctx.params.length] ?? fctx.params[localIdx];
    const capType: ValType = localDef ? localDef.type : { kind: "externref" };
    captures.push({ name, type: capType, localIdx });
  }

  // 5. Synthesize the continuation: an exported `__cb_N(captures, awaitValue)`
  //    whose body is the suffix. For `return await P` the suffix is empty and
  //    the resolved value flows straight through `.then` — the continuation
  //    just returns its awaitValue.
  const suffixStmts = split.isReturnAwait ? [] : split.suffix;
  const cont = compileSyntheticAsyncContinuation(ctx, fctx, suffixStmts, captures, resumeBinding, {
    returnAwaitValue: split.isReturnAwait,
  });

  // 6. Creation site (back in the outer frame):
  //    awaited.then(makeCallback(cbId, captures), null)
  // 6a. re-push the awaited promise.
  fctx.body.push({ op: "local.get", index: awaitedLocal } as Instr);
  // 6b. build the continuation callback: makeCallback(cbId, capturesStruct).
  emitMakeContinuationCallback(ctx, fctx, cont, makeCbIdx);
  // 6c. null reject callback (default rethrow / unhandled rejection).
  fctx.body.push({ op: "ref.null.extern" } as Instr);
  // 6d. Promise_then2(promise, onFulfilled, onRejected) -> result Promise.
  //     `then2Idx` is the stable pre-registered index (see step 2 comment).
  fctx.body.push({ op: "call", funcIdx: then2Idx } as Instr);
  // The chained Promise is on the stack — it is the async function's result.
  fctx.body.push({ op: "return" } as Instr);
}

/**
 * Emit the continuation-callback creation site into `fctx`: build the captures
 * struct (or null when there are none), then
 * `__make_callback(cbId, extern.convert_any(capStruct)) -> externref`.
 * Leaves the resulting JS callback (externref) on the stack.
 */
function emitMakeContinuationCallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  cont: { cbId: number; capStructTypeIdx: number; captures: readonly AsyncCapture[] },
  makeCbIdx: number,
): void {
  // arg0: the callback id (i32) — __make_callback dispatches exports[`__cb_${id}`].
  fctx.body.push({ op: "i32.const", value: cont.cbId } as Instr);

  // arg1: the captures, as an externref. With captures, struct.new the cap
  // struct from the live locals (in field order) and extern.convert_any it;
  // with none, pass a null externref.
  if (cont.captures.length > 0 && cont.capStructTypeIdx >= 0) {
    for (const cap of cont.captures) {
      fctx.body.push({ op: "local.get", index: cap.localIdx } as Instr);
    }
    fctx.body.push({ op: "struct.new", typeIdx: cont.capStructTypeIdx } as Instr);
    fctx.body.push({ op: "extern.convert_any" } as Instr);
  } else {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
  }

  // `makeCbIdx` is the stable pre-registered index (collectAsyncCpsImports
  // prepass), passed by the driver — never a late import here.
  fctx.body.push({ op: "call", funcIdx: makeCbIdx } as Instr);
}

/**
 * Compile a nested `await` encountered while the surrounding
 * {@link emitAsyncStateMachine} is driving the body (e.g. `await (x + await y)`).
 *
 * PR1: stub. Nested awaits within a single segment are a follow-up; the joint
 * spec §6.2 lists `return await` as the only tail case required in Slice 2A.
 */
export function compileNestedAwait(ctx: CodegenContext, _fctx: FunctionContext, expr: ts.AwaitExpression): never {
  reportError(
    ctx,
    expr,
    "internal: nested await not yet supported (#1042 PR1 skeleton; follow-up PR adds segment-internal await continuations)",
  );
  // reportError does not return control flow that TS can prove; satisfy `never`.
  throw new Error("unreachable");
}

/**
 * IR entry point (Phase 2B / #1373b). Same machinery, IR input.
 *
 * PR1: stub returning `false` (means "did not handle; caller uses legacy
 * path"). #1373b fills this in.
 */
export function emitAsyncStateMachineFromIr(): boolean {
  return false;
}

/**
 * One segment boundary produced by {@link splitBodyAtAwait}.
 *
 * PR1 handles a body with **exactly one** top-level await appearing as the
 * initializer/operand of one of three canonical statement shapes. The split
 * yields:
 *   - `prefix`: statements that run synchronously before suspension (the
 *     await's own statement is NOT included here; its awaited expression is
 *     surfaced separately as `awaitedExpr`).
 *   - `awaitedExpr`: the operand of the await (the thing we suspend on).
 *   - `resumeBinding`: the `{name,type}` the resolved value binds to on resume
 *     (for `const x = await P`), or `null` for a bare `await P;` /
 *     `return await P`.
 *   - `suffix`: statements that run after resumption (the continuation body).
 *   - `isReturnAwait`: true for `return await P` — the continuation's value IS
 *     the awaited value, so `suffix` is empty and the resolved value settles
 *     the outer promise directly.
 */
export interface AwaitSplit {
  readonly prefix: readonly ts.Statement[];
  readonly awaitedExpr: ts.Expression;
  readonly resumeBinding: { readonly name: string; readonly type: ts.TypeNode | undefined } | null;
  readonly suffix: readonly ts.Statement[];
  readonly isReturnAwait: boolean;
}

/**
 * Split a single-await async function body into a prefix / awaited-expr /
 * suffix triple for the canonical PR1 shapes. Returns `null` if the body does
 * not match one of the three supported shapes (caller falls back to legacy).
 *
 * Supported shapes (the await must be the *sole* top-level await and appear at
 * statement top-level, not nested inside an expression sub-tree):
 *
 *   1. `return await P;`                      → isReturnAwait, no suffix
 *   2. `const x = await P; <rest>`            → resumeBinding=x, suffix=rest
 *      (also `let`/`var`; single declarator only)
 *   3. `await P; <rest>`                      → no binding, suffix=rest
 *
 * Pure: no `ctx`/`fctx` mutation. The shape gate keeps PR1 small and provably
 * correct; richer control flow (awaits in loops/branches, multiple awaits in
 * one segment) is deferred to follow-up slices.
 */
export function splitBodyAtAwait(fn: ts.FunctionLikeDeclaration, plan: AsyncCpsPlan): AwaitSplit | null {
  // PR1 contract: exactly one await, no try-across-await, JS-host only.
  if (plan.awaitPoints.length !== 1) return null;
  if (plan.hasTryAcrossAwait) return null;
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) return null;

  const stmts = body.statements;
  const awaitNode = plan.awaitPoints[0]!;

  // Find the index of the top-level statement that textually contains the
  // await. The await must be DIRECTLY one of the canonical positions in that
  // statement (return-arg, single var-init, or expression-statement expr) —
  // not buried deeper (e.g. `f(await x)` is rejected for PR1).
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]!;
    if (!statementContainsNode(stmt, awaitNode)) continue;

    const prefix = stmts.slice(0, i);
    const suffix = stmts.slice(i + 1);

    // Shape 1: `return await P;`
    if (ts.isReturnStatement(stmt) && stmt.expression && stmt.expression === awaitNode) {
      if (suffix.length !== 0) return null; // dead code after return; reject for PR1
      return { prefix, awaitedExpr: awaitNode.expression, resumeBinding: null, suffix: [], isReturnAwait: true };
    }

    // Shape 2: `const x = await P;` (single declarator, identifier name)
    if (ts.isVariableStatement(stmt)) {
      const decls = stmt.declarationList.declarations;
      if (decls.length !== 1) return null;
      const decl = decls[0]!;
      if (decl.initializer !== awaitNode || !ts.isIdentifier(decl.name)) return null;
      return {
        prefix,
        awaitedExpr: awaitNode.expression,
        resumeBinding: { name: decl.name.text, type: decl.type },
        suffix,
        isReturnAwait: false,
      };
    }

    // Shape 3: `await P;` (bare expression statement)
    if (ts.isExpressionStatement(stmt) && stmt.expression === awaitNode) {
      return { prefix, awaitedExpr: awaitNode.expression, resumeBinding: null, suffix, isReturnAwait: false };
    }

    // The await sits inside an unsupported position within this statement.
    return null;
  }

  return null;
}

/** True if `node` appears anywhere within `stmt`'s subtree (not crossing fn scopes). */
function statementContainsNode(stmt: ts.Node, node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (n === node) {
      found = true;
      return;
    }
    if (isNestedFunctionScope(n) && n !== stmt) return;
    forEachChild(n, walk);
  };
  walk(stmt);
  return found;
}

// ---------------------------------------------------------------------------
// Internal helpers (private to async-cps.ts)
// ---------------------------------------------------------------------------

/**
 * Collect every binding name declared by this function — params (incl.
 * destructuring) and ALL body variable declarations (var/let/const), plus
 * catch-clause params — without crossing nested function scopes. Unlike
 * `collectFunctionOwnLocals` this does NOT skip let/const: CPS liveness must
 * carry any local read after an await, regardless of block scoping.
 */
function collectAllDeclaredNames(fn: ts.FunctionLikeDeclaration, out: Set<string>): void {
  // Params.
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) out.add(p.name.text);
    else collectBindingPatternNames(p.name, out);
  }
  const body = fn.body;
  if (body === undefined) return;
  const walk = (node: ts.Node): void => {
    if (isNestedFunctionScope(node)) return; // their locals are theirs, not ours
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) out.add(node.name.text);
      else collectBindingPatternNames(node.name, out);
    }
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const vd = node.variableDeclaration;
      if (ts.isIdentifier(vd.name)) out.add(vd.name.text);
      else collectBindingPatternNames(vd.name, out);
    }
    forEachChild(node, walk);
  };
  walk(body);
}

/** True for nodes that open a new function scope (awaits inside don't suspend us). */
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

/** Collect `await` expressions in pre-order, not descending into nested fn scopes. */
function collectAwaitPoints(node: ts.Node, out: ts.AwaitExpression[]): void {
  if (isNestedFunctionScope(node)) return;
  if (ts.isAwaitExpression(node)) {
    out.push(node);
    // Continue into the operand — `await (await x)` has two await points.
  }
  forEachChild(node, (child) => collectAwaitPoints(child, out));
}

/**
 * Collect identifiers referenced strictly AFTER `target` in document order
 * within `root`, not descending into nested function scopes. Conservative:
 * once we pass the target node, everything subsequently visited counts.
 */
function collectReferencedAfter(root: ts.Node, target: ts.AwaitExpression, out: Set<string>): void {
  let passedTarget = false;
  const walk = (node: ts.Node): void => {
    if (node === target) {
      passedTarget = true;
      return; // the await's own operand executes BEFORE resumption — skip it
    }
    if (isNestedFunctionScope(node)) {
      // A nested scope after the target may still reference our locals (closure
      // capture), so when we're already past the target, collect from it too.
      if (passedTarget) collectReferencedIdentifiers(node, out);
      return;
    }
    if (passedTarget && ts.isIdentifier(node)) {
      out.add(node.text);
    }
    forEachChild(node, walk);
  };
  walk(root);
}

/** Does any await sit lexically inside a `try` block? (Conservative.) */
function bodyHasTryAcrossAwait(body: ts.Node | undefined): boolean {
  if (body === undefined) return false;
  let found = false;
  const walk = (node: ts.Node, insideTry: boolean): void => {
    if (found || isNestedFunctionScope(node)) return;
    if (insideTry && ts.isAwaitExpression(node)) {
      found = true;
      return;
    }
    if (ts.isTryStatement(node)) {
      // Only the try-block (and catch) span an await for rejection routing.
      walk(node.tryBlock, true);
      if (node.catchClause) walk(node.catchClause, true);
      if (node.finallyBlock) walk(node.finallyBlock, insideTry);
      return;
    }
    forEachChild(node, (child) => walk(child, insideTry));
  };
  walk(body, false);
  return found;
}

/** Does the body contain a `throw` outside any try/catch? (Conservative.) */
function bodyHasUncaughtThrow(body: ts.Node): boolean {
  let found = false;
  const walk = (node: ts.Node, insideTry: boolean): void => {
    if (found || isNestedFunctionScope(node)) return;
    if (!insideTry && ts.isThrowStatement(node)) {
      found = true;
      return;
    }
    if (ts.isTryStatement(node)) {
      walk(node.tryBlock, true);
      // A throw in catch/finally is still "uncaught" by this try.
      if (node.catchClause) walk(node.catchClause, insideTry);
      if (node.finallyBlock) walk(node.finallyBlock, insideTry);
      return;
    }
    forEachChild(node, (child) => walk(child, insideTry));
  };
  walk(body, false);
  return found;
}
