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
//   - `emitAsyncStateMachine` is present but inert: the activation hook in
//     function-body.ts is NOT wired in this PR, and the `asyncCpsActive` gate
//     (see ASYNC_CPS_ENABLED) is hardcoded false, so the emit path is never
//     reached. Emitted Wasm is byte-identical to before — same inert-first
//     pattern as #1586 (alloc sites) and #1587 (ownership).
//     (The `compileNestedAwait` / `emitAsyncStateMachineFromIr` stubs were
//     removed as dead in #3090; #1373b re-adds the IR entry point when real.)
//
// The full lowering (segment emission, capture structs, Promise.then chaining)
// lands in follow-up PRs. See plan/issues/backlog/1042-async-await-state-machine-lowering.md.

import type { TypeOracle } from "../checker/oracle.js";
import { isPromiseType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { forEachChild, ts } from "../ts-api.js";
import { collectBindingPatternNames, collectReferencedIdentifiers } from "./closures.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { RESULT_DONE_FIELD, RESULT_VALUE_FIELD, sanitizeTypeName } from "./frame-core.js";
import { ensureNativeGeneratorResultType } from "./generators-native.js";
import { resolveWasmType } from "./index.js";
import { coerceType, compileExpression, compileStatement } from "./shared.js";
import { ensureAsyncIterator } from "./statements/destructuring.js";
import { compileForOfDestructuring } from "./statements/for-of-destructuring.js";

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
   * (#2906 slice 3b) Top-level `for await (… of …)` loops in the body (not
   * descending into nested fn scopes). A `for await` carries NO
   * `ts.AwaitExpression` — the per-element suspension is implicit in the
   * `awaitModifier` — so it never lands in `awaitPoints`; without this the whole
   * `awaitPoints`-keyed suspension machinery treats a for-await-only body as
   * non-suspending (AG0 unwrap → the loop var holds the un-awaited Promise → NaN
   * for `for await (x of [P.resolve(1), …])`). The native drive lane
   * (`asyncFnNeedsDrive` → `planForAwaitCfg`) keys off THIS list to recognise the
   * fn as suspending and lower the async-iterator drive onto the CFG machine.
   */
  readonly forAwaitPoints: readonly ts.ForOfStatement[];
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
  const forAwaitPoints: ts.ForOfStatement[] = [];
  const body = fn.body;

  // Collect await points in pre-order, WITHOUT descending into nested function
  // scopes — a nested `async` function/arrow has its own state machine and its
  // awaits do not suspend the enclosing function.
  if (body !== undefined) {
    collectAwaitPoints(body, awaitPoints);
    collectForAwaitPoints(body, forAwaitPoints);
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
    forAwaitPoints,
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

/**
 * (#3227 S2) When an awaited operand is the `Promise.resolve(...)` form that
 * {@link awaitIsStaticallyResolved} recognises, return the expression the
 * `await` actually settles to: the single resolve argument, or `"undefined"`
 * for the zero-arg form. Unwraps transparent wrappers and NESTED
 * `Promise.resolve(Promise.resolve(x))` chains (PromiseResolve is idempotent:
 * resolving a promise returns it, so `await` settles to the innermost value).
 *
 * Returns `null` when the operand is not a `Promise.resolve` call — callers
 * then compile the operand itself.
 *
 * Why this exists: the JS-host legacy await passthrough compiled the OPERAND
 * for statically-resolved awaits, but `Promise.resolve(7)` compiles to a host
 * call returning the Promise OBJECT (externref) — not the settled value — so
 * a numeric consumer's externref→f64 coercion read NaN (the await-NaN cluster
 * behind ~875 honest fails in the #3227 S1 census). Substituting the resolve
 * argument delivers the settled value (§27.7.5.3 Await + §27.2.4.7
 * Promise.resolve: for non-thenable x, `await Promise.resolve(x)` ≡ x up to
 * scheduling, which js2wasm's synchronous model collapses).
 */
export function staticPromiseResolveSettledExpr(operand: ts.Expression): ts.Expression | "undefined" | null {
  let expr: ts.Expression = operand;
  let settled: ts.Expression | "undefined" | null = null;
  for (;;) {
    while (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isTypeAssertionExpression(expr) ||
      ts.isNonNullExpression(expr)
    ) {
      expr = expr.expression;
    }
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      ts.isIdentifier(expr.expression.expression) &&
      expr.expression.expression.text === "Promise" &&
      expr.expression.name.text === "resolve"
    ) {
      if (expr.arguments.length === 0) return "undefined";
      if (expr.arguments.length === 1) {
        settled = expr.arguments[0]!;
        expr = settled;
        continue; // keep unwrapping nested Promise.resolve(Promise.resolve(x))
      }
      return settled; // >1 args: not the recognised form; keep last match (or null)
    }
    return settled;
  }
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
export function awaitedExprIsPromiseCombinator(operand: ts.Expression): boolean {
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
  readonly resumeBinding: {
    readonly name: string;
    readonly type: ts.TypeNode | undefined;
  } | null;
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
  if (body === undefined) return null;

  // (#2957 phase 2) Concise arrow expression body: `async (x) => EXPR`. It is
  // semantically `return EXPR`, so the single canonical `async (x) => await P`
  // shape is exactly a `return await P`. Only the tail form is accepted — the
  // whole concise body IS the await (anything richer, e.g. `=> f(await P)`, is
  // rejected just like the buried-await case in a block body). Function
  // declarations always have block bodies and never reach this branch, so it is
  // additive and cannot perturb the declaration lane.
  if (!ts.isBlock(body)) {
    const awaitNode = plan.awaitPoints[0]!;
    if ((body as ts.Node) === (awaitNode as ts.Node)) {
      return {
        prefix: [],
        awaitedExpr: awaitNode.expression,
        resumeBinding: null,
        suffix: [],
        isReturnAwait: true,
      };
    }
    return null;
  }

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
      return {
        prefix,
        awaitedExpr: awaitNode.expression,
        resumeBinding: null,
        suffix: [],
        isReturnAwait: true,
      };
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
      return {
        prefix,
        awaitedExpr: awaitNode.expression,
        resumeBinding: null,
        suffix,
        isReturnAwait: false,
      };
    }

    // The await sits inside an unsupported position within this statement.
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Multi-await linear planning (#2906 slice 1 — the N-state drive substrate).
//
// `splitBodyAtAwait` above is the SINGLE-await split that the JS-host CPS path
// (`emitAsyncStateMachine`) and `asyncFnNeedsCps` gate on; it is intentionally
// left UNCHANGED so the host/gc lanes stay byte-identical. `planLinearAwaits`
// is the generalization used ONLY by the host-free drive layer (`async-frame.ts`,
// carrier-gated on `isStandalonePromiseActive`, wasi-only today): it splits a
// LINEAR async body (no try/catch/finally-across-await, no await inside loops or
// other control flow) into an ordered list of suspend segments, one per await,
// which the general `br`-table-style resume machine drives.
// ---------------------------------------------------------------------------

/**
 * One suspend segment of a linear multi-await body. Segment `k` runs the
 * statements immediately preceding await `k` (in the same top-level sequence),
 * then evaluates await `k`'s operand and suspends on it.
 */
export interface LinearAwaitSegment {
  /** Top-level statements between the previous await's statement and this one. */
  readonly leadStmts: readonly ts.Statement[];
  /** The operand of this await (the value we assimilate + suspend on). */
  readonly awaitedExpr: ts.Expression;
  /**
   * The binding this await's resolved value flows into (`const x = await P`), or
   * `null` for a bare `await P;` / `return await P`. Delivered fresh from
   * `SENT_FIELD` on resume — never snapshotted at suspend time.
   */
  readonly resumeBinding: {
    readonly name: string;
    readonly type: ts.TypeNode | undefined;
  } | null;
  /** `return await P` — the resolved value settles the result promise directly. */
  readonly isReturnAwait: boolean;
  /**
   * (#2906 Gap 3) `true` when THIS await sits inside a `try` whose `finally` must
   * run if the await rejects. `false` when not inside a try/finally. Slice scope:
   * a single, non-nested `try { …awaits… } finally { F }` with an await-free `F`,
   * no `catch`, and no `return` in the try body (anything richer makes
   * `planLinearAwaits` return `null` → legacy/AG0 fallback).
   */
  readonly awaitInTry: boolean;
  /**
   * (#2906 Gap 3) Per-statement flag parallel to `leadStmts`: `leadInTry[i]` is
   * `true` when `leadStmts[i]` runs INSIDE the try region (a throw there must run
   * the finally). Covers both the outer→in-try entry and the in-try→finally exit
   * boundaries within a single lead (the `finally` body itself is flagged
   * `false` — a throw in it must not re-run it).
   */
  readonly leadInTry: readonly boolean[];
}

/**
 * A linear async body split into N ordered suspend segments plus the tail that
 * runs after the last await resolves. Produced by {@link planLinearAwaits}.
 */
export interface LinearAwaitPlan {
  /** One segment per await point, in source order. */
  readonly segments: readonly LinearAwaitSegment[];
  /** Statements after the last await's statement (empty for `return await P`). */
  readonly tail: readonly ts.Statement[];
  /** (#2906 Gap 3) Per-statement in-try flag parallel to `tail` (see `leadInTry`). */
  readonly tailInTry: readonly boolean[];
  /**
   * (#2906 Gap 3) The single `finally` body of the try/finally spanning an await,
   * or `null` when the body has none. The drive layer compiles it a SECOND time
   * into the resume function's outer `catch` (the abrupt path) — the inline copy
   * on the normal path is already woven into the segment/tail lead statements.
   */
  readonly finalizer: readonly ts.Statement[] | null;
}

/**
 * Split a LINEAR async function body (a flat statement sequence whose awaits all
 * sit at canonical top-level positions) into ordered suspend segments. This is
 * the multi-await generalization of {@link splitBodyAtAwait}: each await must be
 * DIRECTLY the return-arg / single-var-initializer / expression-statement of a
 * top-level statement — exactly the three shapes `splitBodyAtAwait` accepts, but
 * now any number of them in sequence.
 *
 * Returns `null` (caller falls back to the legacy / AG0 path) when the body is
 * not linear-canonical: no awaits, a try/catch spanning an await (Gap 3), an
 * await nested inside a loop / `if` / expression (Gap 5 / non-linear), more than
 * one await in a single statement, or dead code after a `return await`.
 *
 * Pure — no `ctx`/`fctx` mutation; type-eligibility (spill-safe resume-binding
 * types) is a separate gate applied by the drive layer.
 */
export function planLinearAwaits(fn: ts.FunctionLikeDeclaration, plan: AsyncCpsPlan): LinearAwaitPlan | null {
  if (plan.awaitPoints.length === 0) return null;
  const body = fn.body;
  if (body === undefined) return null;
  if (!ts.isBlock(body)) {
    // (#2967 slice 2b) CONCISE arrow body. The one drivable concise shape is
    // `async (…) => await P` (possibly parenthesized) — semantically
    // `{ return await P; }`, i.e. the single-segment isReturnAwait plan. This
    // is exactly the concise population the CPS lane (`splitBodyAtAwait`)
    // owned, so admitting it here moves those closures onto the frame engine
    // (observable only via the closure activation path — declarations never
    // have concise bodies). Any richer concise body (`=> f(await P)`,
    // `=> (await P) + 1`) has its await NESTED in an expression — not
    // linear-canonical, keep the legacy/CPS fallback.
    let e: ts.Expression = body;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isAwaitExpression(e)) return null;
    if (plan.awaitPoints.length !== 1 || plan.awaitPoints[0] !== e) return null;
    return {
      segments: [
        {
          leadStmts: [],
          awaitedExpr: e.expression,
          resumeBinding: null,
          isReturnAwait: true,
          awaitInTry: false,
          leadInTry: [],
        },
      ],
      tail: [],
      tailInTry: [],
      finalizer: null,
    };
  }

  const awaitSet = new Set<ts.AwaitExpression>(plan.awaitPoints);
  const st: LowerState = {
    segments: [],
    lead: [],
    leadInTry: [],
    finalizer: null,
    theFinalizer: null,
    usedFinally: false,
    sawReturnAwait: false,
  };
  if (!lowerLinearStatements(body.statements, st, awaitSet)) return null;

  // Every await must have been consumed into a segment (defensive; a stray await
  // in a `lead` statement would have made `awaitsHere > 0` and been handled).
  if (st.segments.length !== plan.awaitPoints.length) return null;
  return {
    segments: st.segments,
    tail: st.lead,
    tailInTry: st.leadInTry,
    finalizer: st.theFinalizer,
  };
}

/** Mutable accumulator threaded through the recursive linear-await lowering. */
interface LowerState {
  segments: LinearAwaitSegment[];
  lead: ts.Statement[];
  /** Per-statement in-try flag, parallel to `lead`. */
  leadInTry: boolean[];
  /** The active `finally` body if currently inside the try (else null). */
  finalizer: ts.Statement[] | null;
  /** The one finally body of this fn (for the abrupt-path catch copy). */
  theFinalizer: ts.Statement[] | null;
  /** A finally has already been consumed — a second try/finally falls back (single-try slice). */
  usedFinally: boolean;
  sawReturnAwait: boolean;
}

/**
 * Lower a statement sequence into suspend segments (#2906). Recurses ONE level
 * into a `try { … } finally { F }` whose try body carries the awaits (Gap 3),
 * carrying `F` as the active finalizer for every await inside — mirroring
 * `generators-native.ts lowerStatements` + `activeFinalizers`, bounded to a
 * single non-nested finally. Returns `false` (→ legacy/AG0 fallback) on any
 * shape outside the slice.
 */
function lowerLinearStatements(
  statements: readonly ts.Statement[],
  st: LowerState,
  awaitSet: ReadonlySet<ts.AwaitExpression>,
): boolean {
  const pushLead = (stmt: ts.Statement): void => {
    st.lead.push(stmt);
    st.leadInTry.push(st.finalizer !== null);
  };
  const resetLead = (): void => {
    st.lead = [];
    st.leadInTry = [];
  };

  for (const stmt of statements) {
    const awaitsHere = countAwaitsInStatement(stmt, awaitSet);
    if (awaitsHere === 0) {
      if (st.sawReturnAwait) return false; // unreachable code after `return await`
      pushLead(stmt);
      continue;
    }
    if (awaitsHere > 1) return false; // two awaits in one statement — not linear-canonical

    // (#2906 Gap 3) try/finally spanning an await — the try body carries the
    // awaits, the finally runs on every completion. Bounded slice: single,
    // non-nested finally, no catch, await-free finally, no return-in-try.
    if (ts.isTryStatement(stmt)) {
      if (st.finalizer !== null) return false; // nested try/finally — fall back
      if (st.usedFinally) return false; // a second try/finally in the fn — single-try slice
      if (stmt.catchClause) return false; // try/catch — Gap 3 follow-up
      if (!stmt.finallyBlock) return false; // a try with no finally + await — fall back
      const finallyStmts = stmt.finallyBlock.statements;
      for (const f of finallyStmts) if (countAwaitsInStatement(f, awaitSet) > 0) return false; // await-in-finally
      if (blockHasTopLevelReturn(stmt.tryBlock)) return false; // return-in-try (return-through-finally) — follow-up
      st.finalizer = [...finallyStmts];
      st.theFinalizer = st.finalizer;
      st.usedFinally = true;
      if (!lowerLinearStatements(stmt.tryBlock.statements, st, awaitSet)) return false;
      // Normal path: finally runs inline after the try body, flagged NOT-in-try
      // (a throw in the finally itself must not re-run it).
      st.finalizer = null;
      for (const f of finallyStmts) pushLead(f);
      continue;
    }

    const awaitNode = findAwaitInStatement(stmt, awaitSet)!;
    const awaitInTry = st.finalizer !== null;
    const leadStmts = st.lead;
    const leadInTry = st.leadInTry;

    // The await must be DIRECTLY one of the three canonical positions.
    if (ts.isReturnStatement(stmt) && stmt.expression === awaitNode) {
      if (awaitInTry) return false; // `return await` in a try → return-through-finally, follow-up
      st.segments.push({
        leadStmts,
        awaitedExpr: awaitNode.expression,
        resumeBinding: null,
        isReturnAwait: true,
        awaitInTry,
        leadInTry,
      });
      resetLead();
      st.sawReturnAwait = true;
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      const decls = stmt.declarationList.declarations;
      if (decls.length !== 1) return false;
      const decl = decls[0]!;
      if (decl.initializer !== awaitNode || !ts.isIdentifier(decl.name)) return false;
      st.segments.push({
        leadStmts,
        awaitedExpr: awaitNode.expression,
        resumeBinding: { name: decl.name.text, type: decl.type },
        isReturnAwait: false,
        awaitInTry,
        leadInTry,
      });
      resetLead();
      continue;
    }
    if (ts.isExpressionStatement(stmt) && stmt.expression === awaitNode) {
      st.segments.push({
        leadStmts,
        awaitedExpr: awaitNode.expression,
        resumeBinding: null,
        isReturnAwait: false,
        awaitInTry,
        leadInTry,
      });
      resetLead();
      continue;
    }
    return false; // await sits in a non-canonical position within this statement
  }
  return true;
}

/** True if `block` contains a `return` at any depth (not crossing nested fn scopes). */
function blockHasTopLevelReturn(block: ts.Block): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found || isNestedFunctionScope(node)) return;
    if (ts.isReturnStatement(node)) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  };
  forEachChild(block, walk);
  return found;
}

/** Count how many of `awaitSet`'s awaits sit inside `stmt` (not crossing fn scopes). */
function countAwaitsInStatement(stmt: ts.Node, awaitSet: ReadonlySet<ts.AwaitExpression>): number {
  let n = 0;
  const walk = (node: ts.Node): void => {
    if (isNestedFunctionScope(node) && node !== stmt) return;
    if (ts.isAwaitExpression(node) && awaitSet.has(node)) n++;
    forEachChild(node, walk);
  };
  walk(stmt);
  return n;
}

/** The single `awaitSet` await inside `stmt`, or `undefined`. */
function findAwaitInStatement(
  stmt: ts.Node,
  awaitSet: ReadonlySet<ts.AwaitExpression>,
): ts.AwaitExpression | undefined {
  let found: ts.AwaitExpression | undefined;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (isNestedFunctionScope(node) && node !== stmt) return;
    if (ts.isAwaitExpression(node) && awaitSet.has(node)) {
      found = node;
      return;
    }
    forEachChild(node, walk);
  };
  walk(stmt);
  return found;
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
// CFG-aware resume-machine plan (#2906 slice 3 — the general state graph).
//
// `LinearAwaitPlan` above encodes control flow IMPLICITLY: state `s` always
// continues at `s+1`, the tail runs last, and the single try/finally is a
// per-statement boolean. That shape cannot express a loop back-edge (for-await /
// while-with-await), a conditional branch between states, `try/catch` regions,
// or completion replay through an awaited finally. `AsyncCfgPlan` is the general
// contract between the PLANNER (which lowers an async body into states) and the
// DRIVE-LAYER EMITTER (`async-frame.ts ensureAsyncResumeFunction`, which turns
// states into the dispatch machine):
//
//   - a **state** is a basic block of the async CFG: an optional resume prelude
//     (deliver the predecessor await's value / re-throw its rejection), a list
//     of handler-annotated lead statements, and exactly one **terminator**;
//   - a **terminator** transfers control: `suspend` (await → resume at
//     `resumeState`), `goto` / `condGoto` (state transition, incl. back-edges —
//     emitted as `STATE=<target>; br <re-dispatch loop>`, so a target ≤ the
//     current id is a loop), and `settleSent` / `settleUndefined` (fulfil the
//     result promise);
//   - a **handler region** is a lexical try region; every statement/terminator
//     carries the region id it executes in (0 = none). The emitter maintains a
//     region-id local across the machine and the outer catch routes abrupt
//     completions by it (slice-2 semantics: run the region's await-free
//     finalizer, then reject).
//
// Emitter contract (MUST hold for every plan a planner produces):
//   1. State ids are DENSE and equal to their index in `states` (the dispatch
//      if-chain depth arithmetic depends on it).
//   2. A state with `resumeFrom !== null` is entered ONLY through its await's
//      resume/advance (it is exactly one suspend terminator's `resumeState`);
//      `goto`/`condGoto` targets must have `resumeFrom: null`. State 0 (the
//      entry) has `resumeFrom: null`.
//   3. `suspend.resumeState` / `goto.target` / `condGoto.whenTrue|whenFalse`
//      name existing state ids.
//   4. Handler ids are 1-based and dense; `handlers[i].id === i + 1`.
//
// Slice 3 ships the emitter for this full contract plus `linearPlanToCfg` (the
// trivial chain producer), so richer shapes — loops, try/catch, for-await —
// are PLANNER-ONLY follow-ups that never touch the emitter again.
// ---------------------------------------------------------------------------

/**
 * (#2906 slice 3b) An emit escape hatch. A `for await` loop's iterator-protocol
 * steps — `GetAsyncIterator(expr)`, the per-iteration `it.next()`, the `done`
 * flag test, the element value — are RUNTIME operations on wasm locals, not
 * checker-typed `ts.Expression`s, and synthesising the AST for them is the #2367
 * wall (a synthetic identifier the checker cannot type mis-lowers property /
 * element access). So the for-await planner injects those steps as raw
 * instructions via these hooks; the CFG machine's state/terminator/suspend/
 * back-edge substrate is otherwise unchanged, which is what makes this carrier
 * reusable by async-generators (3d). Pre-existing (linear / while) plans use NO
 * hooks, so their emitted machine is byte-identical.
 *
 * A `AsyncCfgValueEmit` pushes exactly ONE value and returns its `ValType`
 * (consumed like a `compileExpression` result); a `AsyncCfgStepEmit` runs a
 * side-effecting step and leaves the stack balanced. Both are invoked with the
 * resume function's `(ctx, fctx)` at emit time.
 */
export type AsyncCfgValueEmit = (ctx: CodegenContext, fctx: FunctionContext) => ValType;
export type AsyncCfgStepEmit = (ctx: CodegenContext, fctx: FunctionContext) => void;

/** A terminator operand that is either a checker-typed AST node or an emit hook. */
export type AsyncCfgOperand = ts.Expression | { readonly emit: AsyncCfgValueEmit };

/** True when an operand is an injected emit hook rather than a `ts.Expression`. */
export function isEmitOperand(op: AsyncCfgOperand): op is { readonly emit: AsyncCfgValueEmit } {
  return typeof (op as { emit?: unknown }).emit === "function";
}

/** One handler-annotated statement of a state's straight-line lead. */
export interface AsyncCfgStmt {
  readonly stmt: ts.Statement;
  /** Handler region this statement executes in (0 = none). */
  readonly handler: number;
}

/**
 * The resume prelude of a state that is some await's `resumeState`: re-throw a
 * rejected predecessor (arming its handler region first so the finalizer runs),
 * then bind the delivered `SENT_FIELD` value.
 */
export interface AsyncResumePoint {
  readonly binding: {
    readonly name: string;
    readonly type: ts.TypeNode | undefined;
  } | null;
  /** Handler region the suspended await sat in (0 = none). */
  readonly handler: number;
}

/** A state's single control-transfer. See the contract block above. */
export type AsyncCfgTerminator =
  | {
      readonly kind: "suspend";
      /**
       * The await operand (assimilated to a `$Promise` / host promise). A
       * `ts.Expression` for linear/while awaits; an emit hook for for-await,
       * whose awaited value is the iterator's `next()` element held in a wasm
       * local (#2906 slice 3b).
       */
      readonly awaited: AsyncCfgOperand;
      /** State entered on resume AND on the synchronous fulfilled/rejected advance. */
      readonly resumeState: number;
      /** Handler region the await executes in (0 = none). */
      readonly handler: number;
    }
  | { readonly kind: "goto"; readonly target: number }
  | {
      readonly kind: "condGoto";
      /**
       * Condition, compiled with `ensureI32Condition` truthiness. A
       * `ts.Expression` for while/if heads; an emit hook (pushing the i32 `done`
       * flag) for the for-await loop head (#2906 slice 3b).
       */
      readonly cond: AsyncCfgOperand;
      readonly whenTrue: number;
      readonly whenFalse: number;
      /** Handler region the condition evaluates in (0 = none). */
      readonly handler: number;
    }
  | { readonly kind: "settleSent" } // `return await P` — fulfil with SENT directly
  | { readonly kind: "settleUndefined" } // fall off the body — fulfil with undefined
  | {
      // (#2906 slice 3d-i) Async-generator `yield E`: fulfil the CURRENT
      // `next()`-promise (`frame.result_promise`, re-minted per `next()` call)
      // with an IteratorResult `{value: E, done: false}`, set STATE=resumeState,
      // and `return` — the machine SUSPENDS until the next `next()` kick, which
      // re-mints the result promise and re-dispatches at `resumeState`. Unlike
      // `suspend` it registers NO promise reaction (a yield does not await): the
      // consumer's next `next()` is the sole resumption driver.
      readonly kind: "settleYield";
      /** The yielded value. `null` ⇒ `fromSent` (yield the delivered await value). */
      readonly value: AsyncCfgOperand | null;
      /** Yield `SENT_FIELD` directly (`yield await P` — the awaited value). */
      readonly fromSent: boolean;
      /** State entered on the next `next()` kick after this yield. */
      readonly resumeState: number;
    }
  | { readonly kind: "settleDone" }; // async-gen body end — fulfil `{value: undefined, done: true}`

/** One basic block of the async CFG. */
export interface AsyncCfgState {
  readonly id: number;
  readonly resumeFrom: AsyncResumePoint | null;
  readonly lead: readonly AsyncCfgStmt[];
  readonly terminator: AsyncCfgTerminator;
  /**
   * (#2906 slice 3b) Extra instructions emitted AFTER the resume prelude + lead
   * and BEFORE the terminator — the for-await planner uses it to inject
   * `it = GetAsyncIterator(source)` (entry) and `it.next()` → done/value locals
   * (loop head). Must leave the stack balanced. `undefined` for all other plans.
   */
  readonly emit?: AsyncCfgStepEmit;
  /**
   * (#3228) Extra instructions emitted immediately AFTER the resume prelude
   * (`emitDeliver`) and BEFORE the lead statements — the for-await planner uses
   * it to destructure the settled element carrier (`FORAWAIT_ELEM`) into the
   * head's binding pattern, so the bound names are live when the leads read
   * them. Must leave the stack balanced. `undefined` for every other plan and
   * for an identifier head.
   */
  readonly postDeliverEmit?: AsyncCfgStepEmit;
}

/**
 * A lexical try region whose completion routing the machine owns. Slice-3
 * scope: an await-free `finalizer` run by the outer catch before rejecting
 * (slice-2 semantics). The catch-body / replay-through-finally generalization
 * (regions with `catchState`/`finallyState` entries that are themselves states)
 * is the 3c planner+emitter follow-up — see the issue design notes.
 */
export interface AsyncHandlerRegion {
  /** 1-based dense id (0 means "no region" everywhere else). */
  readonly id: number;
  /** Enclosing region id (0 = none). Single-region plans use 0. */
  readonly parent: number;
  /** Await-free finally body, compiled a second time into the outer catch. */
  readonly finalizer: readonly ts.Statement[];
}

/** The full machine plan the drive-layer emitter consumes. */
export interface AsyncCfgPlan {
  readonly states: readonly AsyncCfgState[];
  readonly handlers: readonly AsyncHandlerRegion[];
}

/**
 * Lower a {@link LinearAwaitPlan} into the equivalent {@link AsyncCfgPlan}: the
 * trivial chain 0 → 1 → … → N where state `k` suspends on await `k` and state
 * `N` runs the tail (or settles SENT for `return await`). The single optional
 * finalizer becomes handler region 1. Pure; emits nothing.
 *
 * This converter is deliberately the ONLY producer in slice 3, so the emitted
 * machine is byte-identical to the pre-CFG emitter for every accepted shape —
 * richer planners (loops, try/catch, for-await) plug in behind the same plan
 * type without touching the emitter.
 */
export function linearPlanToCfg(linear: LinearAwaitPlan): AsyncCfgPlan {
  const handlers: AsyncHandlerRegion[] =
    linear.finalizer !== null ? [{ id: 1, parent: 0, finalizer: linear.finalizer }] : [];
  const N = linear.segments.length;
  const states: AsyncCfgState[] = [];
  for (let k = 0; k < N; k++) {
    const seg = linear.segments[k]!;
    const prev = k > 0 ? linear.segments[k - 1]! : null;
    states.push({
      id: k,
      resumeFrom: prev ? { binding: prev.resumeBinding, handler: prev.awaitInTry ? 1 : 0 } : null,
      lead: seg.leadStmts.map((stmt, i) => ({
        stmt,
        handler: seg.leadInTry[i] ? 1 : 0,
      })),
      terminator: {
        kind: "suspend",
        awaited: seg.awaitedExpr,
        resumeState: k + 1,
        handler: seg.awaitInTry ? 1 : 0,
      },
    });
  }
  const last = linear.segments[N - 1]!;
  states.push({
    id: N,
    resumeFrom: {
      binding: last.resumeBinding,
      handler: last.awaitInTry ? 1 : 0,
    },
    lead: last.isReturnAwait
      ? []
      : linear.tail.map((stmt, i) => ({
          stmt,
          handler: linear.tailInTry[i] ? 1 : 0,
        })),
    terminator: last.isReturnAwait ? { kind: "settleSent" } : { kind: "settleUndefined" },
  });
  return { states, handlers };
}

// ---------------------------------------------------------------------------
// CFG producer + while-loop planner (#2906 slice 3a).
//
// `planAsyncCfg` is the single entry point the drive lane uses to obtain an
// `AsyncCfgPlan`. For a LINEAR body it delegates to the proven
// `planLinearAwaits` → `linearPlanToCfg` path, so every non-loop program's
// emitted machine is byte-identical to the pre-3a emitter. When `opts.allowLoops`
// is set (native drive lane only, from `asyncFnNeedsDrive`) and the body is a
// single canonical `while (cond) { …await… }` shape, `planWhileLoopCfg` builds
// the loop CFG directly: a head state whose `condGoto` enters the body or the
// exit, body suspend states, and a continuation state whose `goto(head)` is the
// back-edge. The emitter already handles `goto`/`condGoto`/back-edges (a target
// ≤ the current id is a loop), so this is planner-only.
// ---------------------------------------------------------------------------

/** Options for {@link planAsyncCfg}. */
export interface AsyncCfgOptions {
  /**
   * Accept loop shapes (while-with-await). Set only on the native drive lane
   * (`asyncFnNeedsDrive`); the JS-host lane keeps the linear-only shape until a
   * follow-up widens it (the host lane suspends on EVERY await → N iterations =
   * N microtask rounds; correct but needs its own corpus check).
   */
  readonly allowLoops: boolean;
}

/**
 * The single CFG producer for the drive lane. Linear bodies delegate to the
 * byte-identical `linearPlanToCfg(planLinearAwaits(...))` path; when loops are
 * allowed, a canonical `while`-with-await body is lowered by
 * {@link planWhileLoopCfg}. Returns `null` (→ legacy/AG0 fallback) for anything
 * outside the accepted shapes.
 */
export function planAsyncCfg(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
  opts: AsyncCfgOptions,
): AsyncCfgPlan | null {
  const linear = planLinearAwaits(fn, plan);
  if (linear !== null) return linearPlanToCfg(linear);
  if (opts.allowLoops) {
    const whileCfg = planWhileLoopCfg(fn, plan);
    if (whileCfg !== null) return whileCfg;
    // (#2906 slice 3d-ii) `for await (const x of g())` where `g` is a host-free
    // async GENERATOR — the async-iterator CONSUMER, tried before the 3b array
    // carrier. Self-gates to async-gen sources (returns null otherwise), so an
    // array source falls through to `planForAwaitCfg` byte-identically.
    const genConsumer = planForAwaitAsyncCfg(ctx, fn, plan);
    if (genConsumer !== null) return genConsumer;
    // (#2906 slice 3b) `for await (… of …)` over a boxed array — the sync
    // async-iterator carrier drive.
    return planForAwaitCfg(fn, plan);
  }
  return null;
}

/**
 * Structural analysis of a single-`while`-with-await async body. Returns the
 * pre-loop leads, the loop condition, the lowered body (suspend segments + tail),
 * and the post-loop leads — or `null` when the body is not the bounded 3a shape.
 *
 * Bounded slice (everything else → legacy/AG0 fallback):
 *   - the body is a flat statement block whose ONLY awaiting statement is a
 *     single `while` (pre/post statements are await-free);
 *   - the `while` condition is await-free (an awaiting condition needs a
 *     condition-eval state — a follow-up);
 *   - the loop body is linear-canonical (the same per-statement await positions
 *     `lowerLinearStatements` accepts) with ≥1 await and NO `return await`
 *     (a function return through the loop is a follow-up);
 *   - no `break`/`continue`/labeled statement/nested loop/`switch`/`try`/`return`
 *     inside the loop body (abrupt loop/function exit — a follow-up).
 */
function analyzeWhileAsync(
  fn: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): {
  pre: ts.Statement[];
  cond: ts.Expression;
  segments: LinearAwaitSegment[];
  tail: ts.Statement[];
  post: ts.Statement[];
  whileStmt: ts.WhileStatement;
} | null {
  if (plan.awaitPoints.length === 0) return null;
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) return null;
  const awaitSet = new Set<ts.AwaitExpression>(plan.awaitPoints);

  // Find the single top-level statement carrying awaits; it must be a `while`.
  let whileIdx = -1;
  for (let i = 0; i < body.statements.length; i++) {
    const c = countAwaitsInStatement(body.statements[i]!, awaitSet);
    if (c === 0) continue;
    if (whileIdx !== -1) return null; // awaits in >1 top-level statement — not this shape
    if (!ts.isWhileStatement(body.statements[i]!)) return null; // await outside a while
    whileIdx = i;
  }
  if (whileIdx === -1) return null;
  const whileStmt = body.statements[whileIdx] as ts.WhileStatement;

  // await in the condition → needs a condition-eval state (follow-up).
  if (countAwaitsInStatement(whileStmt.expression, awaitSet) > 0) return null;

  // Reject abrupt-exit / non-linear control inside the loop body.
  if (loopBodyHasUnsupportedControl(whileStmt.statement)) return null;

  const bodyStmts = ts.isBlock(whileStmt.statement) ? whileStmt.statement.statements : [whileStmt.statement];

  // Lower the loop body into suspend segments via the shared linear lowering.
  const st: LowerState = {
    segments: [],
    lead: [],
    leadInTry: [],
    finalizer: null,
    theFinalizer: null,
    usedFinally: false,
    sawReturnAwait: false,
  };
  if (!lowerLinearStatements(bodyStmts, st, awaitSet)) return null;
  if (st.segments.length === 0) return null; // no canonical await in the body
  if (st.segments.length !== plan.awaitPoints.length) return null; // stray await elsewhere
  for (const seg of st.segments) if (seg.isReturnAwait) return null; // return-await in loop — follow-up
  if (st.theFinalizer !== null) return null; // try/finally in loop — follow-up

  return {
    pre: [...body.statements.slice(0, whileIdx)],
    cond: whileStmt.expression,
    segments: st.segments,
    tail: st.lead,
    post: [...body.statements.slice(whileIdx + 1)],
    whileStmt,
  };
}

/** True when the loop body contains control the bounded 3a slice cannot express. */
function loopBodyHasUnsupportedControl(loopBody: ts.Statement): boolean {
  let bad = false;
  const walk = (node: ts.Node): void => {
    if (bad) return;
    if (isNestedFunctionScope(node)) return; // a nested fn's break/return is its own
    if (
      ts.isBreakStatement(node) ||
      ts.isContinueStatement(node) ||
      ts.isReturnStatement(node) ||
      ts.isLabeledStatement(node) ||
      ts.isSwitchStatement(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isTryStatement(node)
    ) {
      bad = true;
      return;
    }
    forEachChild(node, walk);
  };
  walk(loopBody);
  return bad;
}

/**
 * Build the loop CFG for a bounded `while (cond) { …await… }` async body.
 * State layout (dense ids in push order):
 *   [entry]  pre-loop leads → goto(head)          (only when pre is non-empty)
 *    head    lead=[]        → condGoto(cond, body0, exit)   ← back-edge target
 *    body_k  seg_k leads    → suspend(seg_k.await, resume→next)   (k = 0..m-1)
 *    cont    tail leads     → goto(head)                    (the back-edge)
 *    exit    post leads     → settleUndefined
 */
function planWhileLoopCfg(fn: ts.FunctionLikeDeclaration, plan: AsyncCpsPlan): AsyncCfgPlan | null {
  const shape = analyzeWhileAsync(fn, plan);
  if (shape === null) return null;
  const { pre, cond, segments, tail, post } = shape;
  const m = segments.length;

  const hasPre = pre.length > 0;
  const headId = hasPre ? 1 : 0;
  const body0Id = headId + 1;
  const contId = body0Id + m; // continuation after the last body await
  const exitId = contId + 1;

  const asLead = (stmts: readonly ts.Statement[]): AsyncCfgStmt[] => stmts.map((stmt) => ({ stmt, handler: 0 }));

  const states: AsyncCfgState[] = [];
  if (hasPre) {
    states.push({ id: 0, resumeFrom: null, lead: asLead(pre), terminator: { kind: "goto", target: headId } });
  }
  // Loop head: evaluate the condition, branch into the body or the exit.
  states.push({
    id: headId,
    resumeFrom: null,
    lead: [],
    terminator: { kind: "condGoto", cond, whenTrue: body0Id, whenFalse: exitId, handler: 0 },
  });
  // Body suspend states (one per await).
  for (let k = 0; k < m; k++) {
    const seg = segments[k]!;
    states.push({
      id: body0Id + k,
      resumeFrom: k === 0 ? null : { binding: segments[k - 1]!.resumeBinding, handler: 0 },
      lead: asLead(seg.leadStmts),
      terminator: {
        kind: "suspend",
        awaited: seg.awaitedExpr,
        resumeState: k < m - 1 ? body0Id + k + 1 : contId,
        handler: 0,
      },
    });
  }
  // Continuation: deliver the last await's value, run the tail, loop back.
  states.push({
    id: contId,
    resumeFrom: { binding: segments[m - 1]!.resumeBinding, handler: 0 },
    lead: asLead(tail),
    terminator: { kind: "goto", target: headId },
  });
  // Exit: run the post-loop statements, settle undefined.
  states.push({
    id: exitId,
    resumeFrom: null,
    lead: asLead(post),
    terminator: { kind: "settleUndefined" },
  });

  return { states, handlers: [] };
}

/**
 * (#2906 slice 3a) The own-locals that must be spilled for a `while`-with-await
 * body, plus the body's suspend segments (for resume-binding spill types). Every
 * own-local (non-param) referenced anywhere in the loop statement is live across
 * the loop-carried await — a local read textually BEFORE the await is read again
 * AFTER the resume on the next iteration — so the whole set is spilled (rule 3/4
 * of the 3a contract: widen to every loop own-local + every resume binding is
 * self-live). Returns `null` when the body is not the bounded while shape.
 */
export function loopAsyncSpillInfo(
  fn: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): { names: string[]; segments: readonly LinearAwaitSegment[] } | null {
  const shape = analyzeWhileAsync(fn, plan);
  if (shape === null) return null;
  const ownLocals = new Set<string>();
  collectAllDeclaredNames(fn, ownLocals);
  const paramNames = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) paramNames.add(p.name.text);
    else collectBindingPatternNames(p.name, paramNames);
  }
  // Names referenced anywhere in the while statement that are own body locals.
  const names: string[] = [];
  const seen = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (isNestedFunctionScope(node)) return;
    if (ts.isIdentifier(node) && ownLocals.has(node.text) && !paramNames.has(node.text) && !seen.has(node.text)) {
      seen.add(node.text);
      names.push(node.text);
    }
    forEachChild(node, walk);
  };
  walk(shape.whileStmt);
  return { names, segments: shape.segments };
}

// ---------------------------------------------------------------------------
// for-await-of drive (#2906 slice 3b — the async-iterator carrier).
//
// A `for await (const x of source)` over a SYNC-backed async iterable (the
// dominant test262 shape — `for await (x of [P.resolve(1), …])` / a sync
// iterable) is spec-equivalent to
//
//     it = GetAsyncIterator(source)          // §7.4.3: use @@asyncIterator if
//                                            // present, else wrap the sync one
//     loop:  { done, value } = it.next()     // sync IteratorStep
//            if (done) break
//            x = await value                  // §27.1.4.4 AsyncFromSyncIterator
//            <body>                           // Await(value): a Promise element
//     exit:  <post statements>               //   double-resolves to its value
//
// which is a loop with ONE suspend per iteration — exactly the 3a while-with-
// await machine. So no NEW emitter machinery is needed for the DRIVE; the gap
// (per the #2906 3b grounding) was below the machine: (1) a `for await` carries
// no `ts.AwaitExpression`, so the fn read as non-suspending (→ AG0 → NaN), and
// (2) the iterator-protocol steps (`GetAsyncIterator`, `it.next()`, the done
// flag, the element) are runtime ops on wasm locals — not checker-typed AST, and
// synthesising that AST is the #2367 wall. `planForAwaitCfg` closes both: it is
// gated on `plan.forAwaitPoints` (fix 1) and injects the protocol steps via the
// `AsyncCfgStepEmit`/`AsyncCfgValueEmit` hooks (fix 2), reusing the CFG machine's
// suspend + back-edge substrate verbatim. This is the same carrier async
// generators (3d) consume.
// ---------------------------------------------------------------------------

/** Reserved spill-slot name for the persisted async-iterator (survives every
 *  per-element suspend). Shared with `computeForAwaitSpills` in async-frame.ts. */
export const FORAWAIT_ITER_SPILL = "__forawait_iter";

/** (#3228) Reserved local holding the settled per-element value delivered from
 *  `SENT_FIELD` when the for-await head is a DESTRUCTURING binding. The resume
 *  machinery delivers the element into it exactly as it would an identifier
 *  binding; a post-deliver hook then runs IteratorBindingInitialization
 *  (`compileForOfDestructuring`) against it. Delivered fresh each resume, so
 *  it — and the pattern names it binds — are excluded from the spill set. */
export const FORAWAIT_ELEM = "__forawait_elem";

/** The bounded `for await` shape `planForAwaitCfg`/`forAwaitSpillInfo` accept. */
interface ForAwaitShape {
  pre: ts.Statement[];
  source: ts.Expression;
  binding: { name: string; type: ts.TypeNode | undefined };
  /** (#3228) Set when the head is a destructuring binding (`for await (const
   *  {a} of …)`). `binding.name` is then the synthetic {@link FORAWAIT_ELEM}
   *  element carrier and this pattern is destructured from it on resume. */
  pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern | undefined;
  body: ts.Statement[];
  post: ts.Statement[];
  forStmt: ts.ForOfStatement;
}

/**
 * Recognise an async body whose ONLY suspension is a single top-level
 * `for await (const x of source) { … }`. Returns the pre-loop leads, the source
 * expression, the (identifier) binding, the loop body, and the post-loop leads —
 * or `null` when the body is outside the bounded slice.
 *
 * Bounded slice (everything else → legacy/AG0 fallback):
 *   - NO bare `await` anywhere in the body (`awaitPoints` empty) and EXACTLY one
 *     `for await` (multi/mixed suspension is a follow-up);
 *   - the `for await` is a flat top-level statement of the fn body;
 *   - a simple `const`/`let x` identifier binding (destructuring / expression
 *     head is a follow-up — #2906 3b′);
 *   - the loop body is linear-canonical with NO `break`/`continue`/`return`/
 *     nested loop/`try`/labeled/`switch` (abrupt loop exit must call
 *     `it.return()` — an async close, itself a suspend — banked as 3b′).
 */
function analyzeForAwait(fn: ts.FunctionLikeDeclaration, plan: AsyncCpsPlan): ForAwaitShape | null {
  if (plan.awaitPoints.length !== 0) return null; // mixed bare-await + for-await — follow-up
  if (plan.forAwaitPoints.length !== 1) return null;
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) return null;
  const forStmt = plan.forAwaitPoints[0]!;

  // Must be a top-level statement of the fn body (not nested in if/loop/try).
  let forIdx = -1;
  for (let i = 0; i < body.statements.length; i++) {
    if (body.statements[i] === forStmt) {
      forIdx = i;
      break;
    }
  }
  if (forIdx === -1) return null;

  // Head binding: a simple identifier (`for await (const x of …)`) OR — (#3228)
  // — an object/array destructuring pattern (`for await (const {a} of …)`).
  const init = forStmt.initializer;
  if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) return null;
  const decl = init.declarations[0]!;
  let binding: { name: string; type: ts.TypeNode | undefined };
  let pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern | undefined;
  if (ts.isIdentifier(decl.name)) {
    if (decl.name.text === FORAWAIT_ITER_SPILL) return null; // reserved synthetic name collision
    binding = { name: decl.name.text, type: decl.type };
  } else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
    // (#3228) Deliver the settled element into a synthetic carrier local; a
    // post-deliver hook runs `compileForOfDestructuring` against it. The
    // element is an externref in the drive (`L.value`/`SENT_FIELD`), so its
    // carrier is untyped (externref).
    pattern = decl.name;
    binding = { name: FORAWAIT_ELEM, type: undefined };
  } else {
    return null;
  }

  // Loop body: reuse the while-slice's abrupt-control rejection (also rejects a
  // nested `for await`, since it is a `ForOfStatement`).
  if (loopBodyHasUnsupportedControl(forStmt.statement)) return null;
  const bodyStmts = ts.isBlock(forStmt.statement) ? [...forStmt.statement.statements] : [forStmt.statement];

  return {
    pre: [...body.statements.slice(0, forIdx)],
    source: forStmt.expression,
    binding,
    pattern,
    body: bodyStmts,
    post: [...body.statements.slice(forIdx + 1)],
    forStmt,
  };
}

/**
 * (#2906 slice 3b) The own-locals a `for await` body must spill into the frame
 * (they survive the per-element suspend), plus the loop binding for exclusion.
 * Every own-local referenced anywhere in the `for await` statement is live across
 * the loop-carried suspend (read before the await, read again after resume on the
 * next iteration — the 3a loop-liveness rule), MINUS params and MINUS the loop
 * binding itself (delivered fresh from `SENT_FIELD` on resume, never snapshotted).
 * The synthetic async-iterator carrier local is appended by
 * `computeForAwaitSpills`. Returns `null` when the body is not the bounded shape.
 */
export function forAwaitSpillInfo(
  fn: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): { names: string[]; binding: { name: string; type: ts.TypeNode | undefined } } | null {
  const shape = analyzeForAwait(fn, plan);
  if (shape === null) return null;
  const ownLocals = new Set<string>();
  collectAllDeclaredNames(fn, ownLocals);
  const paramNames = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) paramNames.add(p.name.text);
    else collectBindingPatternNames(p.name, paramNames);
  }
  // (#3228) A destructuring head binds its pattern names FRESH from the settled
  // element on every resume (via `compileForOfDestructuring` in the post-deliver
  // hook), exactly like an identifier binding is delivered fresh from SENT — so
  // they are NOT loop-carried and must be excluded from the spill set (spilling
  // them as externref would also collide with the destructuring's own typed
  // local slot).
  const excluded = new Set<string>([shape.binding.name]);
  if (shape.pattern !== undefined) collectBindingPatternNames(shape.pattern, excluded);
  const names: string[] = [];
  const seen = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (isNestedFunctionScope(node)) return;
    if (
      ts.isIdentifier(node) &&
      ownLocals.has(node.text) &&
      !paramNames.has(node.text) &&
      !excluded.has(node.text) && // resume binding / dstr pattern names — delivered fresh
      !seen.has(node.text)
    ) {
      seen.add(node.text);
      names.push(node.text);
    }
    forEachChild(node, walk);
  };
  walk(shape.forStmt);
  return { names, binding: shape.binding };
}

/**
 * (#2906 slice 3b) Should a bounded `for await` take the native async-iterator
 * DRIVE, or stay on the legacy path? This is the drive gate — `asyncFnNeedsDrive`
 * calls it, so the routing and `planForAwaitCfg` stay consistent.
 *
 * Drive ONLY when the source's element type is BOXED (externref / GC-ref) — a
 * Promise/thenable/object element whose `Await` can genuinely suspend, and whose
 * runtime representation the native `__iterator` vec carrier consumes. Rationale:
 *   - a source of UNBOXED primitives (`number[]`, `boolean[]`) settles
 *     immediately (`Await(v) = v`), so the legacy sync-unwrap path is ALREADY
 *     correct; and those arrays use a typed WasmGC representation the vec iterator
 *     cannot `ref.cast` — driving them would trap (a regression);
 *   - a non-array / user-iterable source (`getNumberIndexType() === undefined`)
 *     may be a user ASYNC iterable whose `next()` the sync native iterator can't
 *     drive — keep it on legacy for now (a 3b′ follow-up: general
 *     `AsyncFromSyncIterator` / user-`@@asyncIterator`).
 * So the driven set is exactly the proven case: an array whose elements are
 * boxed (Promise arrays — the −32 for-await cluster — and object/string arrays).
 * Returns `false` for a non-for-await / non-bounded body.
 *
 * Element-type query goes through `ctx.oracle.elementFactOf` (the #1930 type
 * boundary — NOT the raw checker, per the oracle-ratchet gate).
 */
export function forAwaitNeedsDrive(ctx: CodegenContext, fn: ts.FunctionLikeDeclaration, plan: AsyncCpsPlan): boolean {
  const shape = analyzeForAwait(fn, plan);
  if (shape === null) return false;
  // (#3228) A destructuring head over an async-GENERATOR source stays on legacy
  // — the async-gen CONSUMER path (`planForAwaitAsyncCfg`) is identifier-only
  // (that dstr follow-up is #3132's lane). Keep this gate consistent with the
  // sync `planForAwaitCfg`, which returns null for that same shape, so drive is
  // never enabled without a matching plan.
  if (shape.pattern !== undefined && resolveAsyncGenNextHelperName(ctx, shape.source) !== null) return false;
  const elem = ctx.oracle.elementFactOf(shape.source);
  switch (elem.kind) {
    // Unboxed scalars settle immediately (`Await(v) = v`, legacy already
    // correct) and their typed WasmGC arrays would trap the vec iterator.
    case "number":
    case "boolean":
    case "bigint":
    case "undefined":
    case "null":
    case "void":
    // No element fact: a non-array / user-iterable source — keep on legacy (3b′).
    case "unresolvable":
      return false;
    // Boxed element (Promise/object/class/builtin/string/array/tuple/function/
    // any/unknown/union): the vec `__iterator` consumes it and `Await` can
    // genuinely suspend.
    default:
      return true;
  }
}

/**
 * Build the CFG for a bounded `for await (const x of source) { body }` async
 * body. Dense state ids in push order:
 *   entry(0) : pre leads → emit `it = GetAsyncIterator(source)` → goto(head)
 *   head(1)  : emit `{done,value} = it.next()` → condGoto(done, exit, body)
 *   body(2)  : (empty) → suspend(await value, resume→resume)   ← the Await
 *   resume(3): deliver x = SENT; body leads → goto(head)        ← the back-edge
 *   exit(4)  : post leads → settleUndefined
 * The iterator-protocol steps are injected via emit hooks (the element value and
 * done flag live in wasm locals, not AST); the suspend + back-edge are the stock
 * CFG machine. Returns `null` when the body is not the bounded shape.
 */
export function planForAwaitCfg(fn: ts.FunctionLikeDeclaration, plan: AsyncCpsPlan): AsyncCfgPlan | null {
  const shape = analyzeForAwait(fn, plan);
  if (shape === null) return null;
  const { pre, source, binding, pattern, body, post, forStmt } = shape;

  // (#3228) Destructuring head: after the settled element is delivered into the
  // `FORAWAIT_ELEM` carrier (unchanged resume machinery), run
  // IteratorBindingInitialization against it via the SAME helper the sync for-of
  // path uses. The element is an externref (`SENT_FIELD`/`L.value`), so it routes
  // through the externref destructuring decls (`__extern_get`).
  const destructureElem: AsyncCfgStepEmit | undefined =
    pattern === undefined
      ? undefined
      : (ctx, fctx) => {
          const elemLocal = fctx.localMap.get(FORAWAIT_ELEM);
          if (elemLocal === undefined) return; // carrier absent (unreachable in the drive lane)
          compileForOfDestructuring(ctx, fctx, pattern, elemLocal, { kind: "externref" }, forStmt);
        };

  // Wasm locals shared across the emit hooks, resolved at emit time. `iter` is
  // the persisted spill slot (allocated by the resume-fn prologue from
  // FORAWAIT_ITER_SPILL); `value`/`done` are transient (recomputed each
  // iteration head, never crossing a suspend, so not spilled).
  const L = { iter: -1, value: -1, done: -1 };

  const asLead = (stmts: readonly ts.Statement[]): AsyncCfgStmt[] => stmts.map((stmt) => ({ stmt, handler: 0 }));

  const entryId = 0;
  const headId = 1;
  const bodyId = 2;
  const resumeId = 3;
  const exitId = 4;

  // entry emit: it = GetAsyncIterator(source), into the persisted spill slot.
  const initIterator: AsyncCfgStepEmit = (ctx, fctx) => {
    const iterSlot = fctx.localMap.get(FORAWAIT_ITER_SPILL);
    L.iter = iterSlot !== undefined ? iterSlot : allocLocal(fctx, FORAWAIT_ITER_SPILL, { kind: "externref" });
    const srcType = compileExpression(ctx, fctx, source);
    if (srcType !== null && srcType !== undefined) {
      coerceType(ctx, fctx, srcType as ValType, { kind: "externref" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    const iterIdx = ensureAsyncIterator(ctx, fctx);
    if (iterIdx === undefined) {
      // Only reachable if the native iterator runtime is unavailable (not the
      // standalone/wasi drive lane this planner runs on); leave iter null.
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "local.set", index: L.iter });
      return;
    }
    fctx.body.push({ op: "call", funcIdx: iterIdx });
    fctx.body.push({ op: "local.set", index: L.iter });
  };

  // head emit: {done, value} = it.next() (multi-value: value on top, done below).
  const stepNext: AsyncCfgStepEmit = (ctx, fctx) => {
    if (L.value === -1) L.value = allocLocal(fctx, "__forawait_value", { kind: "externref" });
    if (L.done === -1) L.done = allocLocal(fctx, "__forawait_done", { kind: "i32" });
    const nextIdx = ctx.funcMap.get("__iterator_next");
    if (nextIdx === undefined) {
      // Native iterator runtime absent — deliver done=1 so the loop exits.
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "local.set", index: L.value });
      fctx.body.push({ op: "i32.const", value: 1 });
      fctx.body.push({ op: "local.set", index: L.done });
      return;
    }
    fctx.body.push({ op: "local.get", index: L.iter });
    fctx.body.push({ op: "call", funcIdx: nextIdx });
    fctx.body.push({ op: "local.set", index: L.value });
    fctx.body.push({ op: "local.set", index: L.done });
  };

  const doneCond: AsyncCfgValueEmit = (_ctx, fctx) => {
    fctx.body.push({ op: "local.get", index: L.done });
    return { kind: "i32" };
  };

  const awaitValue: AsyncCfgValueEmit = (_ctx, fctx) => {
    fctx.body.push({ op: "local.get", index: L.value });
    return { kind: "externref" };
  };

  const states: AsyncCfgState[] = [
    {
      id: entryId,
      resumeFrom: null,
      lead: asLead(pre),
      emit: initIterator,
      terminator: { kind: "goto", target: headId },
    },
    {
      id: headId,
      resumeFrom: null,
      lead: [],
      emit: stepNext,
      terminator: { kind: "condGoto", cond: { emit: doneCond }, whenTrue: exitId, whenFalse: bodyId, handler: 0 },
    },
    {
      id: bodyId,
      resumeFrom: null,
      lead: [],
      terminator: { kind: "suspend", awaited: { emit: awaitValue }, resumeState: resumeId, handler: 0 },
    },
    {
      id: resumeId,
      resumeFrom: { binding, handler: 0 },
      // (#3228) For a destructuring head, run the pattern bind BEFORE the body
      // leads (which reference the bound names); `undefined` for an identifier
      // head (byte-identical to the pre-#3228 plan).
      postDeliverEmit: destructureElem,
      lead: asLead(body),
      terminator: { kind: "goto", target: headId },
    },
    {
      id: exitId,
      resumeFrom: null,
      lead: asLead(post),
      terminator: { kind: "settleUndefined" },
    },
  ];
  return { states, handlers: [] };
}

// ---------------------------------------------------------------------------
// for-await-of over an async GENERATOR — the async-iterator CONSUMER (#2906
// slice 3d-ii).
//
// `for await (const x of g())` where `g` is a host-free async generator (3d-i)
// is the DUAL of the sync-iterator 3b carrier: instead of a synchronous
// `it.next()` returning `(done, value)` and an `await` on the ELEMENT, an
// async-gen's `next()` returns a `Promise<IteratorResult>` — you `await` the
// NEXT()-PROMISE first, then read `done`/`value` from the resolved
// IteratorResult (§27.6.3.4 AsyncGenerator.prototype.next → §27.6.1.2). The
// async gen IS its own async iterator (`[Symbol.asyncIterator]() { return this }`),
// so `GetAsyncIterator(g()) === g()` — the frame carrier the 3d-i producer
// returns. Lowered onto the SAME CFG machine (no new emitter/terminator):
//
//   entry: it = g()                          — the 3d-i frame carrier (spill it)
//   head:  p = __async_gen_next_<g>(it)       — mint+kick, returns a $Promise
//          suspend(await p, resume → chk)      — the next()-promise suspension
//   chk:   {done,value} = SENT (IteratorResult) ; x = value
//          if (done) goto exit else goto body   — the done test AFTER the await
//   body:  <body> ; goto head                   — the back-edge
//   exit:  <post> ; settleUndefined
//
// `p = next()`, the IteratorResult field reads and the `x` bind are RUNTIME ops
// on wasm locals (not checker-typed AST — the #2367 wall), so they ride the same
// `AsyncCfgStepEmit`/`AsyncCfgValueEmit` hooks 3b introduced. The next()-promise
// is a native `$Promise`, so the stock `suspend` arm assimilates it verbatim: a
// SYNCHRONOUSLY-settled yield (plain `yield E`) fulfils the promise inside the
// `next()` call → fast-path advance; a genuinely-pending `yield await P` leaves
// it pending → the consumer suspends and `__drain_microtasks` resumes it (a
// two-level microtask chain producer↔consumer).
// ---------------------------------------------------------------------------

/** The reserved synthetic local holding the awaited IteratorResult (SENT) in the
 *  async-gen for-await CONSUMER's `chk` state, before its fields are unpacked. */
const FORAWAIT_ARESULT = "__forawait_aresult";

/** (#2570) Reserved synthetic locals of the `yield*` DELEGATE pump: the awaited
 *  inner IteratorResult (the chk state's resume binding) and its unpacked
 *  done/value. Transient within one dispatch (bound at resume, consumed by the
 *  chk/yield states before the next suspend), so never spilled; shared across a
 *  body's delegate segments (only one delegation is active per dispatch). */
const YIELDSTAR_RESULT = "__yieldstar_result";
const YIELDSTAR_DONE = "__yieldstar_done";
const YIELDSTAR_VALUE = "__yieldstar_value";

/**
 * (#2906 slice 3d-ii) If `source` is a direct call `g(...)` to a host-free async
 * GENERATOR whose per-gen `next()` driver is ALREADY registered, return that
 * driver's name (`__async_gen_next_<stem>`); else `null`.
 *
 * The `funcMap.has` check is the order-robust drive gate: function bodies compile
 * in source order (declarations.ts), so the producer's `emitAsyncGenerator`
 * registers `__async_gen_next_<stem>` iff `g` was declared BEFORE this consumer —
 * the natural (and only lazily-correct) order. A forward-referenced async gen (or
 * a non-async-gen callee) leaves the helper absent → we return `null` and the
 * consumer stays on legacy/AG0 (correct-or-legacy, the #2367 graveyard rule).
 * The name is derived identically to the producer (`sanitizeTypeName` of the
 * callee identifier == the generator's declaration name), so a match is exact.
 *
 * Bounded to a direct named-function call `g(...)`; a gen held in a const/arrow
 * (`asyncFnName` → `anon_<pos>`) or a member call is a 3d-iii edge.
 */
function resolveAsyncGenNextHelperName(ctx: CodegenContext, source: ts.Expression): string | null {
  // (#3132) A VAR-HELD async-gen FRAME: `var it = (async function*(){})();
  // for await (x of it)`. The `for await` source is the identifier `it`, not a
  // direct call — resolve its (single) initializer, which must itself be a
  // direct async-gen call, and recurse. Only a const/var whose initializer is a
  // CallExpression qualifies (a reassigned / param-held / member-held binding
  // cannot be statically tied to one producer → stays legacy, correct-or-legacy).
  // This is the row-flipping half of the ~390-file for-await-over-async-gen leak
  // (the producer is already driven; the CONSUMER bailed to legacy CPS because
  // the frame was held in a variable rather than called inline).
  const { checker } = ctx;
  if (ts.isIdentifier(source)) {
    const sym = checker.getSymbolAtLocation(source);
    const vd = sym?.valueDeclaration;
    if (
      vd !== undefined &&
      ts.isVariableDeclaration(vd) &&
      vd.initializer !== undefined &&
      ts.isCallExpression(vd.initializer)
    ) {
      return resolveAsyncGenNextHelperName(ctx, vd.initializer);
    }
    return null;
  }
  if (!ts.isCallExpression(source)) return null;
  let callee: ts.Expression = source.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isIdentifier(callee)) {
    const name = `__async_gen_next_${sanitizeTypeName(callee.text)}`;
    if (ctx.funcMap.has(name)) return name;
    // (#2865) A const/var-held fn-EXPRESSION producer (`const f = async
    // function* () {...}`) registers under its synthesized anon stem, not the
    // binding name. Resolve the callee's declaration through the checker and
    // match the producer registry by INITIALIZER NODE — exact, no naming games.
    if (ctx.asyncGenProducers !== undefined) {
      const sym = checker.getSymbolAtLocation(callee);
      const vd = sym?.valueDeclaration;
      if (vd !== undefined && ts.isVariableDeclaration(vd) && vd.initializer !== undefined) {
        for (const [stem, p] of ctx.asyncGenProducers) {
          if (p.decl === vd.initializer) {
            const exprName = `__async_gen_next_${stem}`;
            if (ctx.funcMap.has(exprName)) return exprName;
          }
        }
      }
    }
    return null;
  }
  // (#3132) An IIFE async-gen producer: `(async function*(){})()` — the callee
  // is the async-gen function EXPRESSION itself. Match the producer registry by
  // its declaration node (registered by `emitAsyncGenerator` when the fn-expr
  // compiled, in source order before this consumer).
  if ((ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) && ctx.asyncGenProducers !== undefined) {
    for (const [stem, p] of ctx.asyncGenProducers) {
      if (p.decl === callee) {
        const exprName = `__async_gen_next_${stem}`;
        if (ctx.funcMap.has(exprName)) return exprName;
      }
    }
  }
  return null;
}

/**
 * (#2906 slice 3d-ii) Should a bounded `for await (const x of g())` take the
 * async-generator CONSUMER drive? True iff the body is the bounded for-await
 * shape AND the source is a host-free async-gen call whose `next()` driver is
 * registered. The shared spill-safe gate is applied by `asyncFnNeedsDrive` (it
 * reuses `computeForAwaitSpills` — the consumer's frame layout is the SAME as a
 * 3b for-await: loop own-locals + the persisted iterator spill).
 */
export function forAwaitAsyncNeedsDrive(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): boolean {
  const shape = analyzeForAwait(fn, plan);
  if (shape === null) return false;
  // (#3132) A destructuring head over an async-gen source is now driven natively
  // (composes #2996's IteratorBindingInitialization delivery with the async-gen
  // consumer CFG — see `planForAwaitAsyncCfg`). Both identifier and pattern heads
  // route here once the source resolves to a host-free async-gen next-helper.
  return resolveAsyncGenNextHelperName(ctx, shape.source) !== null;
}

/**
 * Build the CFG for a bounded `for await (const x of g())` over an async
 * generator. Dense state ids in push order:
 *   entry(0) : pre leads → emit `it = g()` (the 3d-i frame carrier) → goto(head)
 *   head(1)  : emit `p = __async_gen_next_<g>(it)` → suspend(await p, resume→chk)
 *   chk(2)   : (resumeFrom binds SENT = IteratorResult) emit unpack done/value +
 *              bind x=value → condGoto(done, exit, body)
 *   body(3)  : body leads → goto(head)                         ← the back-edge
 *   exit(4)  : post leads → settleUndefined
 * The `next()` call, IteratorResult field reads and `x` bind are injected via the
 * emit hooks (runtime wasm-local ops, not AST); suspend + back-edge are the stock
 * CFG machine. Returns `null` when the body is not the bounded async-gen shape.
 */
export function planForAwaitAsyncCfg(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
  plan: AsyncCpsPlan,
): AsyncCfgPlan | null {
  const shape = analyzeForAwait(fn, plan);
  if (shape === null) return null;
  const nextHelperName = resolveAsyncGenNextHelperName(ctx, shape.source);
  if (nextHelperName === null) return null;
  const { pre, source, binding, pattern, body, post, forStmt } = shape;

  // (#3132) Destructuring head over an async-gen source: `chk`'s `unpackResult`
  // binds the IteratorResult `.value` into the `FORAWAIT_ELEM` carrier (because
  // `binding.name === FORAWAIT_ELEM` for a pattern head, per `analyzeForAwait`);
  // then — reusing the SAME `compileForOfDestructuring` the sync for-of and
  // #2996's array-source for-await use — run IteratorBindingInitialization
  // against the carrier at the top of the `bodyId` state (only reached when
  // done=false, before the body leads read the bound names). `undefined` for an
  // identifier head (byte-identical to the pre-#3132 plan).
  const destructureElem: AsyncCfgStepEmit | undefined =
    pattern === undefined
      ? undefined
      : (ctx, fctx) => {
          const elemLocal = fctx.localMap.get(FORAWAIT_ELEM);
          if (elemLocal === undefined) return; // carrier absent (unreachable in the drive lane)
          compileForOfDestructuring(ctx, fctx, pattern, elemLocal, { kind: "externref" }, forStmt);
        };

  // Wasm locals shared across the emit hooks, resolved at emit time. `iter` is
  // the persisted spill slot (allocated by the resume-fn prologue from
  // FORAWAIT_ITER_SPILL); `p`/`done` are transient (recomputed each head, never
  // crossing a suspend, so not spilled).
  const L = { iter: -1, p: -1, done: -1 };

  const asLead = (stmts: readonly ts.Statement[]): AsyncCfgStmt[] => stmts.map((stmt) => ({ stmt, handler: 0 }));

  const entryId = 0;
  const headId = 1;
  const chkId = 2;
  const bodyId = 3;
  const exitId = 4;

  // entry emit: it = g() — the async gen call returns the 3d-i frame carrier
  // (its own async iterator). Store into the persisted spill slot.
  const initIterator: AsyncCfgStepEmit = (ctx, fctx) => {
    const iterSlot = fctx.localMap.get(FORAWAIT_ITER_SPILL);
    L.iter = iterSlot !== undefined ? iterSlot : allocLocal(fctx, FORAWAIT_ITER_SPILL, { kind: "externref" });
    const srcType = compileExpression(ctx, fctx, source);
    if (srcType !== null && srcType !== undefined) {
      coerceType(ctx, fctx, srcType as ValType, { kind: "externref" });
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    fctx.body.push({ op: "local.set", index: L.iter });
  };

  // head emit: p = __async_gen_next_<g>(it) — mint a fresh pending next()-promise,
  // kick the producer to its next yield/await-suspend, return the promise. Resolve
  // the funcIdx fresh (name-based: late imports may have shifted defined indices).
  const stepNext: AsyncCfgStepEmit = (ctx, fctx) => {
    if (L.p === -1) L.p = allocLocal(fctx, "__asyncgen_p", { kind: "externref" });
    const nextIdx = ctx.funcMap.get(nextHelperName);
    if (nextIdx === undefined) {
      // Unreachable: the drive gate (`forAwaitAsyncNeedsDrive`) required the
      // helper to be registered. Emit a null promise so the suspend delivers it
      // plainly (SENT = null → done read below faults to 1 → the loop exits).
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "local.set", index: L.p });
      return;
    }
    fctx.body.push({ op: "local.get", index: L.iter });
    fctx.body.push({ op: "call", funcIdx: nextIdx });
    fctx.body.push({ op: "local.set", index: L.p });
  };

  const awaitNextPromise: AsyncCfgValueEmit = (_ctx, fctx) => {
    fctx.body.push({ op: "local.get", index: L.p });
    return { kind: "externref" };
  };

  // chk emit (runs AFTER the resume prelude delivers SENT into FORAWAIT_ARESULT):
  // unpack the awaited IteratorResult — done → `L.done` (i32), value → `x`
  // (coerced to its binding type; a boxed number stays externref, exactly like
  // the 3b element delivery). Same result struct the producer's settleYield built
  // (`ensureNativeGeneratorResultType` is memoised per element type).
  const unpackResult: AsyncCfgStepEmit = (ctx, fctx) => {
    const resultTypeIdx = ensureNativeGeneratorResultType(ctx, { kind: "externref" });
    const aresSlot = fctx.localMap.get(FORAWAIT_ARESULT)!;
    if (L.done === -1) L.done = allocLocal(fctx, "__asyncgen_done", { kind: "i32" });
    // L.done = (SENT as IteratorResult).done
    fctx.body.push({ op: "local.get", index: aresSlot });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: resultTypeIdx });
    fctx.body.push({ op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: RESULT_DONE_FIELD });
    fctx.body.push({ op: "local.set", index: L.done });
    // x = (SENT as IteratorResult).value  (bound BEFORE the body leads run)
    const xType: ValType = binding.type
      ? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(binding.type))
      : { kind: "externref" };
    const xSlot = fctx.localMap.get(binding.name) ?? allocLocal(fctx, binding.name, xType);
    fctx.body.push({ op: "local.get", index: aresSlot });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: resultTypeIdx });
    fctx.body.push({ op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD });
    coerceType(ctx, fctx, { kind: "externref" }, xType);
    fctx.body.push({ op: "local.set", index: xSlot });
  };

  const doneCond: AsyncCfgValueEmit = (_ctx, fctx) => {
    fctx.body.push({ op: "local.get", index: L.done });
    return { kind: "i32" };
  };

  const states: AsyncCfgState[] = [
    {
      id: entryId,
      resumeFrom: null,
      lead: asLead(pre),
      emit: initIterator,
      terminator: { kind: "goto", target: headId },
    },
    {
      id: headId,
      resumeFrom: null,
      lead: [],
      emit: stepNext,
      terminator: { kind: "suspend", awaited: { emit: awaitNextPromise }, resumeState: chkId, handler: 0 },
    },
    {
      id: chkId,
      // SENT holds the awaited IteratorResult (externref); we unpack it in `emit`.
      resumeFrom: { binding: { name: FORAWAIT_ARESULT, type: undefined }, handler: 0 },
      lead: [],
      emit: unpackResult,
      terminator: { kind: "condGoto", cond: { emit: doneCond }, whenTrue: exitId, whenFalse: bodyId, handler: 0 },
    },
    {
      id: bodyId,
      resumeFrom: null,
      // (#3132) Destructuring head: bind the element carrier into the pattern
      // BEFORE the body leads (which reference the bound names). `undefined` for
      // an identifier head. `bodyId` is reached only when done=false, so the
      // pattern is never destructured against the terminal `{value:undefined}`.
      postDeliverEmit: destructureElem,
      lead: asLead(body),
      terminator: { kind: "goto", target: headId },
    },
    {
      id: exitId,
      resumeFrom: null,
      lead: asLead(post),
      terminator: { kind: "settleUndefined" },
    },
  ];
  return { states, handlers: [] };
}

// ---------------------------------------------------------------------------
// async-generator PRODUCER core (#2906 slice 3d-i).
//
// `async function* g() { yield await P; yield E; … }` currently routes through
// the generator-buffer path and fails at the #680 native-generator gate in
// standalone/wasi — it never reaches the async drive machine. The PRODUCER core
// intercepts a BOUNDED async-gen body BEFORE that gate and lowers it onto the
// SAME CFG resume machine (`ensureAsyncResumeFunction`) the linear/while/
// for-await drives already use, with two new terminators:
//
//   - `settleYield` — `yield E`: fulfil the current `next()`-promise with
//     `{value: E, done: false}` and suspend (no reaction; the next `next()` kick
//     resumes). `yield await P` splits into a `suspend` on `P` (the existing
//     await terminator — genuine microtask suspension) followed by a
//     `settleYield` that yields the delivered `SENT_FIELD` value (`fromSent`).
//   - `settleDone` — body end: fulfil `{value: undefined, done: true}`.
//
// Bounded slice (everything else → the legacy gen path / #680 error, never a
// wrong machine — the #2367 graveyard rule):
//   - the body is a FLAT block whose every statement is `yield <E>` (an
//     expression statement wrapping a non-delegating `YieldExpression`);
//   - `E` is a plain expression, `await <P>`, or absent (`yield;`);
//   - a plain `E` contains no nested `await`/`yield` (those need expression-level
//     suspend-point numbering — a follow-up);
//   - NO own-local declarations (var/let/const) in the body: a local that
//     crosses a yield/await needs the frame-spill widening the linear/loop
//     drives already have; the core keeps spills empty (params are captured in
//     frame fields, so param-only bodies are fine). Own-locals are the immediate
//     3d-i′ follow-up (reuse `computeAsyncSpills`).
// Consumer-side `next(v)`/`.throw()`/`.return()` and prototype-method dispatch
// are 3d-ii (the for-await consumer); the core proves the producer host-free via
// direct `next()`-helper drive.
// ---------------------------------------------------------------------------

/** True when `node` contains an `await`/`yield` not inside a nested fn scope. */
function containsAwaitOrYield(node: ts.Node): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found || isNestedFunctionScope(n)) return;
    if (ts.isAwaitExpression(n) || ts.isYieldExpression(n)) {
      found = true;
      return;
    }
    forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** Does `stmt` contain a `return` statement in its own function scope? A lead
 *  `return v` inside a driven async-GEN body would settle the current
 *  `next()`-promise with the RAW value via the `asyncDriveReturn` hook, not the
 *  §27.6-required IteratorResult `{value, done:true}` — so bodies with returns
 *  stay on the legacy path until a settleReturn terminator exists (3d-iii). */
function containsOwnScopeReturn(stmt: ts.Statement): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found || isNestedFunctionScope(n)) return;
    if (ts.isReturnStatement(n)) {
      found = true;
      return;
    }
    forEachChild(n, walk);
  };
  walk(stmt);
  return found;
}

/** Does the async-gen body declare any own local via a NON-identifier binding
 *  (destructuring)? Those cannot be pre-typed as frame spills
 *  (`resolveSpillLocalValType` needs the declaration node per name and the
 *  destructuring lowering allocates its own differently-typed locals), so the
 *  body stays on the legacy path. */
function asyncGenBodyHasPatternLocals(fn: ts.FunctionLikeDeclaration): boolean {
  const body = fn.body;
  if (body === undefined) return false;
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found || isNestedFunctionScope(n)) return;
    if (ts.isVariableDeclaration(n) && !ts.isIdentifier(n.name)) {
      found = true;
      return;
    }
    forEachChild(n, walk);
  };
  forEachChild(body, walk);
  return found;
}

/** One bounded async-gen yield statement: `yield await <awaited>` OR `yield <plain>`
 *  OR `yield;` (both null), plus the suspend-free LEAD statements preceding it.
 *  (#3120, carrier lane only — see {@link ImplicitYieldAwaitMode}) A plain
 *  `yield E` whose operand is STATICALLY Promise-typed is classified
 *  `awaited: E` — §27.6.3.8 AsyncGeneratorYield performs `Await(value)` on
 *  the operand before suspending, so a promise operand must ride the suspend
 *  lane (settling the raw operand would deliver the promise OBJECT,
 *  f64-coerced → NaN, and FULFIL where a rejecting operand must reject). */
interface AsyncGenYield {
  readonly leads: ts.Statement[];
  readonly awaited: ts.Expression | null;
  readonly plain: ts.Expression | null;
  /**
   * (#2570) `yield* inner(...)` DELEGATION over another driven async-gen
   * producer: the (paren-stripped) call whose result frame is pumped lazily —
   * one inner `next()` per outer `next()` — by the 4-state delegate loop
   * {@link planAsyncGenCfg} plans. Mutually exclusive with `awaited`/`plain`
   * (both null on a delegate segment; `yield;` is distinguished by this field
   * being undefined).
   */
  readonly delegate?: ts.CallExpression;
  /**
   * (#3388) `yield* <expr>` RUNTIME DELEGATION over an ARBITRARY async/sync
   * iterable operand — an identifier, member access, string, element access, or
   * a call the #2570 driven-gen delegate arm did NOT accept. Lowered by
   * {@link planAsyncGenCfg} as a 5-state runtime loop: `GetAsyncIterator` →
   * `__iterator_next` sync step → per-element `await value` (AsyncFromSync
   * §27.1.4.4) → `settleYield` back-edge. The producer-side dual of
   * {@link planForAwaitCfg}. Mutually exclusive with `delegate`/`awaited`/`plain`
   * (all null/undefined on an rtDelegate segment). Statement position only
   * (`yield*`'s completion value is discarded).
   */
  readonly rtDelegate?: ts.Expression;
}

/**
 * (#2570) Delegation admission for `yield* <call>` segments in a driven
 * async-generator body. `accept` is the STATIC admission (must be deterministic
 * pre-body vs emit-time — it may read the checker/AST but NOT emit-order state
 * like `funcMap`/`asyncGenProducers`, because `asyncGenDrivableUnderCarrier`
 * feeds the pre-body `widenAsyncGenFallback` carrier decision with it);
 * `helperNameFor` is the EMIT-time resolution of the inner producer's
 * registered `__async_gen_next_<stem>` driver (registry-backed — only the
 * planner/emit path provides it). `null` delegates mode rejects every
 * `yield* <call>` (the pre-#2570 behavior).
 */
export interface AsyncGenDelegates {
  readonly accept: (call: ts.CallExpression) => boolean;
  readonly helperNameFor?: (call: ts.CallExpression) => string | null;
}

/**
 * (#2570) The top-level `yield* <call>(...)` statements of an async-gen body,
 * in source order — the syntactic delegate-segment candidates. Purely
 * syntactic (no admission check): used to NUMBER the per-segment
 * `__yieldstar_iter_<i>` frame spills consistently between the spill layout
 * (`computeAsyncSpills`) and the CFG planner, which both walk the same
 * statement list. Array-literal `yield*` operands (#3132 S1 static unroll) are
 * not CallExpressions, so they never appear here.
 */
export function listTopLevelYieldStarCalls(fn: ts.FunctionLikeDeclaration): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) return out;
  for (const st of body.statements) {
    const e = ts.isExpressionStatement(st) ? st.expression : null;
    if (e === null || !ts.isYieldExpression(e) || e.asteriskToken === undefined) continue;
    let src = e.expression;
    while (src !== undefined && ts.isParenthesizedExpression(src)) src = src.expression;
    if (src !== undefined && ts.isCallExpression(src)) out.push(src);
  }
  return out;
}

/**
 * (#3388) The top-level `yield* <expr>` statements whose operand is NOT a
 * driven-async-gen call (#2570) and NOT an array literal (#3132 S1) — i.e. the
 * RUNTIME-DELEGATION operands (identifier/member/element-access/string, or a
 * call the driven arm rejects). Used to NUMBER the per-segment
 * `__yieldstar_rtiter_<i>` frame spills consistently between the spill layout
 * (`computeAsyncSpills`) and the CFG planner, which both walk the same
 * statement list. Purely syntactic — the driven/array-literal admission that
 * `analyzeAsyncGen` applies is a REFINEMENT (a call the driven arm accepts is
 * excluded here because it is a CallExpression handled by
 * `listTopLevelYieldStarCalls`), so the two lists partition the `yield*` calls:
 * this returns the operands that will become `rtDelegate` segments.
 */
export function listTopLevelRtDelegateYieldStars(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const out: ts.Expression[] = [];
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) return out;
  for (const st of body.statements) {
    const e = ts.isExpressionStatement(st) ? st.expression : null;
    if (e === null || !ts.isYieldExpression(e) || e.asteriskToken === undefined) continue;
    let src = e.expression;
    while (src !== undefined && ts.isParenthesizedExpression(src)) src = src.expression;
    if (src === undefined) continue;
    // A driven-gen delegate CALL is numbered by listTopLevelYieldStarCalls; an
    // array-literal unrolls statically (no spill). Everything else — including a
    // NON-drivable call — is an rtDelegate operand.
    if (ts.isArrayLiteralExpression(src)) continue;
    if (ts.isCallExpression(src)) continue; // driven-gen call → __yieldstar_iter_<i>
    out.push(src);
  }
  return out;
}

/**
 * (#3120) Classification mode for the implicit §27.6.3.8 yield-operand await.
 * Non-null (carrying the type oracle — the #1930 type-query boundary) ONLY on
 * the native-`$Promise` CARRIER lane (`isStandalonePromiseActive` — wasi
 * today), where the suspend arm can assimilate the awaited operand. `null` on
 * the carrier-off standalone drive lane: there the operand is
 * host-constructed, the suspend arm would mis-handle it, and — decisively —
 * flipping the classification would demote every promise-yield body from the
 * (compiling, driven) await-free lane to the legacy #680 CE, breaking the
 * #2980 fallback's whole-module host-consistency. So carrier-off keeps the
 * pre-#3120 plain classification byte-identically; the VALUE gap on that
 * lane is the #2980 carrier widen's to close, not a reason to stop compiling.
 */
type ImplicitYieldAwaitMode = { readonly oracle: TypeOracle } | null;

/**
 * (#3120) Is the yield OPERAND statically Promise-typed? §27.6.3.8
 * AsyncGeneratorYield awaits its operand implicitly, so a promise-typed plain
 * `yield E` must route through the SAME suspend+settleYield(fromSent) lane as
 * `yield await E`. Only the statically-known promise shape flips: a union
 * with a Promise constituent awaits too (`Await` passes non-thenables through
 * unchanged, so awaiting the union is always safe), while non-promise
 * operands — and `any`-typed ones — stay on the plain fast path. Keeping
 * `any` plain is deliberate: routing every untyped operand through a suspend
 * state would change bytes (and microtask timing) for the vast test262
 * population of untyped non-promise yields the direct-drive proof shows
 * delivering correctly today. A runtime thenable hiding behind `any` is a
 * follow-up (it needs a runtime thenable probe in the settle arm, not a
 * static classification).
 */
function yieldOperandIsPromiseTyped(oracle: TypeOracle, operand: ts.Expression): boolean {
  if (oracle.builtinReceiverOf(operand) === "Promise") return true;
  // (#3207) §27.6.3.8 `AsyncGeneratorYield` awaits ANY thenable, not only the
  // `Promise` builtin. A `PromiseLike<T>`-typed operand is a structural
  // thenable, so it must route through the SAME suspend+settleYield(fromSent)
  // lane as a `Promise`-typed operand. This is correct-or-inert: when the
  // operand is backed by a native `$Promise` at runtime the suspend arm adopts
  // it (delivering the resolved value); a NON-native thenable fails the
  // suspend's `ref.test $Promise` and falls through to the plain delivery — the
  // exact pre-#3207 raw-yield behaviour — so no shape regresses.
  if (oracle.declaredNameOf(operand) === "PromiseLike") return true;
  const parts = oracle.unionPartsOf(operand);
  return parts !== undefined && parts.some((p) => p.kind === "builtin" && p.name === "Promise");
}

/** The bounded async-gen body shape: ordered yield segments (each carrying its
 *  preceding leads) plus the trailing statements after the last yield. A body
 *  with ZERO yields is valid (`segments: []` — pure leads, then done). */
interface AsyncGenShape {
  readonly segments: AsyncGenYield[];
  readonly tailLeads: ts.Statement[];
}

/** Recognise the bounded async-gen body; return its segment list, or `null`
 *  for anything outside the slice.
 *
 *  (#2865 — generalized from the 3d-i flat-yield core.) Accepted now:
 *  arbitrary suspend-free LEAD statements before/between/after top-level
 *  `yield <E>` statements (they compile as ordinary statements of the owning
 *  state's arm), zero-yield bodies (leads → settleDone — e.g. the test262
 *  `forbidden-ext` bodies, which only run assertions), and own identifier
 *  locals (spilled into the frame — see `computeAsyncGenSpills`). Still
 *  rejected (correct-or-legacy): `yield*`, yields nested inside expressions or
 *  control flow, `return` statements (need a settleReturn terminator),
 *  destructuring locals, and nested await/yield inside operands.
 *
 *  (#3120) `implicitYieldAwait` (see {@link ImplicitYieldAwaitMode}) controls
 *  whether a statically Promise-typed plain `yield E` becomes an AWAITED
 *  segment (implicit §27.6.3.8 `Await(operand)`). ACCEPTANCE is mode-neutral
 *  (a promise-typed yield is accepted either way — only its segment
 *  classification differs), so the admission gate and {@link planAsyncGenCfg}
 *  stay consistent as long as both derive the mode from the same
 *  carrier-lane predicate. */
function analyzeAsyncGen(
  fn: ts.FunctionLikeDeclaration,
  implicitYieldAwait: ImplicitYieldAwaitMode,
  delegates: AsyncGenDelegates | null = null,
): AsyncGenShape | null {
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) return null;
  if (asyncGenBodyHasPatternLocals(fn)) return null;
  const segments: AsyncGenYield[] = [];
  let leads: ts.Statement[] = [];
  for (const st of body.statements) {
    const e = ts.isExpressionStatement(st) ? st.expression : null;
    if (e !== null && ts.isYieldExpression(e)) {
      if (e.asteriskToken !== undefined) {
        // (#2570) `yield* inner(...)` DELEGATION over another driven async-gen
        // producer (paren-stripped call operand). Admitted only when the
        // caller's delegates mode statically accepts the call (a resolvable,
        // earlier-declared, itself-drivable top-level async gen — see
        // `resolveAsyncGenDelegateDecl` in async-frame.ts) and the args are
        // suspend-free (they compile inside the delegate INIT state of the
        // resume fn). Everything else falls through to the array-literal
        // static-unroll arm below, or rejects (correct-or-legacy).
        {
          let src: ts.Expression | undefined = e.expression;
          while (src !== undefined && ts.isParenthesizedExpression(src)) src = src.expression;
          if (src !== undefined && ts.isCallExpression(src)) {
            if (delegates === null) return null;
            if (src.arguments.some((a) => containsAwaitOrYield(a))) return null;
            if (!delegates.accept(src)) return null;
            segments.push({ leads, awaited: null, plain: null, delegate: src });
            leads = [];
            continue;
          }
        }
        // (#3132 S1) `yield* [e1, e2, …]` over an ARRAY LITERAL statically
        // unrolls into per-element plain-yield segments — §27.5.3 delegation
        // over an array forwards exactly the `done:false` element values, and
        // an elision hole yields `undefined` (a `yield;` segment). Elements
        // must be suspend-free and non-spread; any other `yield*` operand
        // (identifiers, calls, strings, spread elements) keeps the legacy
        // path (correct-or-legacy). This single gate propagates to
        // `isBoundedAsyncGenBody` / `isAwaitFreeAsyncGenBody` /
        // `isAsyncGenDriveCandidate` / `sourceNeedsGeneratorHostImports`, so
        // the admitted bodies drop their `__gen_*` host-import leak in
        // lockstep with the native emit.
        const src = e.expression;
        if (src !== undefined && ts.isArrayLiteralExpression(src)) {
          for (const el of src.elements) {
            if (ts.isSpreadElement(el)) return null; // spread — runtime drain, S3
            if (ts.isOmittedExpression(el)) {
              segments.push({ leads, awaited: null, plain: null }); // hole → yield undefined
              leads = [];
              continue;
            }
            if (containsAwaitOrYield(el)) return null; // nested suspend — S3
            // (#3120) Promise-typed elements: yield* delegation does NOT apply
            // the implicit AsyncGeneratorYield await to the *inner* iterator's
            // values on the carrier lane distinction we model here — route them
            // through the same mode check as a plain `yield el` for consistency.
            if (implicitYieldAwait !== null && yieldOperandIsPromiseTyped(implicitYieldAwait.oracle, el)) {
              segments.push({ leads, awaited: el, plain: null });
            } else {
              segments.push({ leads, awaited: null, plain: el });
            }
            leads = [];
          }
          continue;
        }
        // (#3388) `yield* <expr>` over an ARBITRARY iterable operand
        // (identifier / member / element-access / string / a call the #2570
        // driven-gen arm above did NOT accept). Lowered as a RUNTIME DELEGATION
        // loop (GetAsyncIterator + __iterator_next sync-step + per-element
        // await + settleYield back-edge) by `planAsyncGenCfg`. Reject only when
        // the operand itself contains a nested suspend (await/yield inside the
        // operand expr — the iterator would have to be produced across a
        // suspend; banked follow-up) or is missing. Statement position only,
        // guaranteed by the enclosing ExpressionStatement match.
        if (src === undefined || containsAwaitOrYield(src)) return null;
        {
          let rtSrc: ts.Expression = src;
          while (ts.isParenthesizedExpression(rtSrc)) rtSrc = rtSrc.expression;
          segments.push({ leads, awaited: null, plain: null, rtDelegate: rtSrc });
          leads = [];
        }
        continue;
      }
      const operand = e.expression;
      if (operand === undefined) {
        segments.push({ leads, awaited: null, plain: null }); // `yield;`
      } else if (ts.isAwaitExpression(operand)) {
        // `yield await P` — reject a doubly-nested await/yield in the awaited operand.
        if (containsAwaitOrYield(operand.expression)) return null;
        segments.push({ leads, awaited: operand.expression, plain: null });
      } else {
        if (containsAwaitOrYield(operand)) return null; // nested await/yield — follow-up
        // (#3120) On the carrier lane, a Promise-typed plain operand carries
        // the implicit AsyncGeneratorYield await — route it awaited.
        if (implicitYieldAwait !== null && yieldOperandIsPromiseTyped(implicitYieldAwait.oracle, operand)) {
          segments.push({ leads, awaited: operand, plain: null });
        } else {
          segments.push({ leads, awaited: null, plain: operand });
        }
      }
      leads = [];
      continue;
    }
    // A LEAD statement: must be suspend-free (a yield/await nested in control
    // flow needs expression-level suspend numbering) and return-free.
    if (containsAwaitOrYield(st)) return null;
    if (containsOwnScopeReturn(st)) return null;
    leads.push(st);
  }
  return { segments, tailLeads: leads };
}

/** True when `fn` is a bounded 3d-i async-generator body drivable host-free.
 *  Acceptance is (#3120-)mode-neutral, so no checker is needed here. */
export function isBoundedAsyncGenBody(
  fn: ts.FunctionLikeDeclaration,
  delegates: AsyncGenDelegates | null = null,
): boolean {
  return analyzeAsyncGen(fn, null, delegates) !== null;
}

/**
 * (#2865) True when `fn` is a bounded async-generator body that is ALSO
 * await-free (`yield <plain>` / `yield;` only — no `yield await P`). This is
 * the shape drivable under `--target standalone` while the native-`$Promise`
 * CARRIER gate is still wasi-only (#2980): with the carrier off, an awaited
 * operand does not lower to a native `$Promise`, so a `yield await P` would
 * deliver the un-awaited promise OBJECT (wrong value). An await-free body is
 * carrier-independent — every promise the machine touches is minted by its own
 * `__async_gen_next_<name>` driver.
 *
 * (#3120) Deliberately classifies with the implicit yield-operand await OFF
 * (`null` mode): this gate serves the carrier-off lane, where a Promise-typed
 * plain `yield P` keeps its pre-#3120 plain classification (still driven,
 * byte-identical) rather than demoting the body to the legacy #680 CE — see
 * {@link ImplicitYieldAwaitMode}.
 */
export function isAwaitFreeAsyncGenBody(
  fn: ts.FunctionLikeDeclaration,
  delegates: AsyncGenDelegates | null = null,
): boolean {
  const shape = analyzeAsyncGen(fn, null, delegates);
  if (shape === null) return false;
  // (#2570) Delegate segments count as await-free: their suspends await
  // promises minted by the INNER producer's own `__async_gen_next_<stem>`
  // driver — always a native `$Promise` regardless of the carrier gate (the
  // same carrier-independence argument as `asyncGenConsumerNeedsDrive`). The
  // inner body's own await-freeness is checked by the delegates mode.
  return shape.segments.every((y) => y.awaited === null);
}

/**
 * (#2865) Every own identifier local a driven async-GEN body must spill into
 * its `$AsyncFrame`. Every `yield` is a suspend point (the resume fn returns
 * and re-enters on the next `next()` kick), so — mirroring the 3a loop rule —
 * every own body local is conservatively treated as live-across-suspend and
 * spilled. Typed via `resolveSpillLocalValType` (the fctx-independent subset of
 * the var-decl type cascade), defaulting to externref; params are captured in
 * param fields, never spilled. Returns the declaration node per name so the
 * caller can apply the spill-safe type gate.
 */
export function asyncGenOwnLocalDecls(fn: ts.FunctionLikeDeclaration): Map<string, ts.VariableDeclaration> {
  const out = new Map<string, ts.VariableDeclaration>();
  const body = fn.body;
  if (body === undefined) return out;
  const paramNames = new Set<string>();
  for (const p of fn.parameters) {
    if (ts.isIdentifier(p.name)) paramNames.add(p.name.text);
    else collectBindingPatternNames(p.name, paramNames);
  }
  const walk = (node: ts.Node): void => {
    if (isNestedFunctionScope(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !paramNames.has(node.name.text)) {
      if (!out.has(node.name.text)) out.set(node.name.text, node);
    }
    forEachChild(node, walk);
  };
  forEachChild(body, walk);
  return out;
}

/**
 * Build the CFG for a bounded async-generator body. Dense ids in push order; an
 * AWAITED segment (`yield await P`, or — #3120, carrier lane only — a
 * Promise-typed plain `yield P`, which carries the implicit §27.6.3.8 await)
 * contributes TWO states (await-suspend + yield-from-sent), a plain `yield E`
 * ONE, and a trailing `settleDone`:
 *
 *   yield await P:  Sk  [leads] suspend(P, resume→Sk+1)         (the await)
 *                   Sk+1 (resumeFrom binding:null) settleYield(fromSent, →Sk+2)
 *   yield E:        Sk  [leads] settleYield(value:E, →Sk+1)
 *   <end>:          Sn  [tail leads] settleDone
 *
 * (#2865) Each yield's suspend-free LEAD statements ride the owning state's
 * `lead` array (the emitter compiles them via `compileStatement` before the
 * terminator — the same mechanism every other CFG producer uses); a zero-yield
 * body is a single settleDone state carrying all statements as leads.
 *
 * Only the yield-from-sent state carries a resume prelude (to re-throw a rejected
 * await via the MODE_THROW arm — a rejected awaited yield rejects the current
 * `next()` promise). Every other state is entered by a `next()` kick with
 * MODE_NEXT, so needs no prelude. Returns `null` for a non-bounded body.
 */
export function planAsyncGenCfg(
  fn: ts.FunctionLikeDeclaration,
  implicitYieldAwait: ImplicitYieldAwaitMode,
  delegates: AsyncGenDelegates | null = null,
): AsyncCfgPlan | null {
  const shape = analyzeAsyncGen(fn, implicitYieldAwait, delegates);
  if (shape === null) return null;
  const asLead = (stmts: readonly ts.Statement[]): AsyncCfgStmt[] => stmts.map((stmt) => ({ stmt, handler: 0 }));
  const states: AsyncCfgState[] = [];
  let id = 0;
  let delegateIdx = 0;
  let rtDelegateIdx = 0;
  for (const y of shape.segments) {
    if (y.rtDelegate !== undefined) {
      // (#3388) `yield* <expr>` RUNTIME DELEGATION over an arbitrary iterable
      // operand (identifier / member / string / non-drivable call) — the
      // producer-side dual of `planForAwaitCfg`. A 3-state loop, one element
      // per outer `next()` kick:
      //
      //   init(k)  : [leads] iter := GetAsyncIterator(operand)   (frame spill —
      //              lazy: runs on the kick that REACHES the yield*) → goto pump
      //   pump(k+1): {done,value} = __iterator_next(iter)   (sync IteratorStep;
      //              transient done/value locals) → condGoto(done, after, yieldOut)
      //   yield(k+2): settleYield(value, resume→pump)   ← the BACK-EDGE: the NEXT
      //              outer kick re-enters pump and steps the iterator again
      //   after(k+3): the next segment's first state (or settleDone)
      //
      // Slice 1 (#3388) does NOT re-await inner element values (consistent with
      // the #3120 mode routing — the operand's element type is unknown, so a
      // raw forward matches the #2570 delegate's behaviour). A rejected
      // GetIterator / next() (TypeError per §27.6.3.7) surfaces through the
      // native `__iterator` / `__iterator_next` USER arms → the outer driven
      // `next()` promise rejection (never a trap). `.throw()`/`.return()`
      // forwarding into the delegate is #3389. The completion value (done
      // result's value) is discarded — `yield*` is accepted in STATEMENT
      // position only.
      const iterSpillName = `__yieldstar_rtiter_${rtDelegateIdx}`;
      rtDelegateIdx += 1;
      const operand = y.rtDelegate;
      const initId = id;
      const pumpId = id + 1;
      const yieldId = id + 2;
      const afterId = id + 3;

      // Transient (same-dispatch) done/value locals — recomputed each pump,
      // never crossing the settleYield suspend (settleYield reads `value` in the
      // SAME dispatch as the pump that set it).
      const RT_DONE = "__yieldstar_rtdone";
      const RT_VALUE = "__yieldstar_rtvalue";

      // init: iter := GetAsyncIterator(operand) into the persisted frame spill.
      const initEmit: AsyncCfgStepEmit = (ctx, fctx) => {
        const iterSlot = fctx.localMap.get(iterSpillName) ?? allocLocal(fctx, iterSpillName, { kind: "externref" });
        const srcType = compileExpression(ctx, fctx, operand);
        if (srcType !== null && srcType !== undefined) {
          coerceType(ctx, fctx, srcType as ValType, { kind: "externref" });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        const iterIdx = ensureAsyncIterator(ctx, fctx);
        if (iterIdx === undefined) {
          // Native iterator runtime unavailable (not the standalone/wasi drive
          // lane this plan runs on) — leave iter null; pump faults done=1.
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "local.set", index: iterSlot });
          return;
        }
        fctx.body.push({ op: "call", funcIdx: iterIdx });
        fctx.body.push({ op: "local.set", index: iterSlot });
      };

      // pump: {done, value} = __iterator_next(iter). The native helper returns
      // (i32 done, externref value) — value on top, done below.
      const pumpEmit: AsyncCfgStepEmit = (ctx, fctx) => {
        const iterSlot = fctx.localMap.get(iterSpillName) ?? allocLocal(fctx, iterSpillName, { kind: "externref" });
        const doneSlot = fctx.localMap.get(RT_DONE) ?? allocLocal(fctx, RT_DONE, { kind: "i32" });
        const valueSlot = fctx.localMap.get(RT_VALUE) ?? allocLocal(fctx, RT_VALUE, { kind: "externref" });
        const nextIdx = ctx.funcMap.get("__iterator_next");
        if (nextIdx === undefined) {
          fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "local.set", index: valueSlot });
          fctx.body.push({ op: "i32.const", value: 1 });
          fctx.body.push({ op: "local.set", index: doneSlot });
          return;
        }
        fctx.body.push({ op: "local.get", index: iterSlot });
        fctx.body.push({ op: "call", funcIdx: nextIdx });
        fctx.body.push({ op: "local.set", index: valueSlot }); // value (top)
        fctx.body.push({ op: "local.set", index: doneSlot }); // done (below)
      };

      const doneCond: AsyncCfgValueEmit = (_ctx, fctx) => {
        fctx.body.push({ op: "local.get", index: fctx.localMap.get(RT_DONE)! });
        return { kind: "i32" };
      };

      const yieldValue: AsyncCfgValueEmit = (_ctx, fctx) => {
        fctx.body.push({ op: "local.get", index: fctx.localMap.get(RT_VALUE)! });
        return { kind: "externref" };
      };

      states.push(
        {
          id: initId,
          resumeFrom: null,
          lead: asLead(y.leads),
          emit: initEmit,
          terminator: { kind: "goto", target: pumpId },
        },
        {
          id: pumpId,
          resumeFrom: null,
          lead: [],
          emit: pumpEmit,
          terminator: { kind: "condGoto", cond: { emit: doneCond }, whenTrue: afterId, whenFalse: yieldId, handler: 0 },
        },
        {
          id: yieldId,
          resumeFrom: null,
          lead: [],
          terminator: { kind: "settleYield", value: { emit: yieldValue }, fromSent: false, resumeState: pumpId },
        },
      );
      id += 3;
      continue;
    }
    if (y.delegate !== undefined) {
      // (#2570) `yield* inner(...)` DELEGATION — the lazy 4-state pump loop.
      // One OUTER `next()` kick pumps the inner driven gen exactly ONE step:
      //
      //   init(k)  : [leads] iter := inner(...)   (frame spill — lazy: runs on
      //              the kick that REACHES the yield*, not at outer())
      //              → goto pump
      //   pump(k+1): suspend(await __async_gen_next_<inner>(iter), resume→chk)
      //   chk(k+2) : (binds SENT = IteratorResult; a rejected inner next()
      //              re-throws via the MODE_THROW prelude → outer's current
      //              next()-promise rejects, §27.6.4.2.5.g)
      //              unpack {done,value} → condGoto(done, after, yieldOut)
      //   yield(k+3): settleYield(value, resume→pump)   ← the BACK-EDGE: the
      //              NEXT outer kick re-enters pump and pumps inner again
      //   after(k+4): the next segment's first state (or settleDone)
      //
      // The inner next()-promise is a native `$Promise` minted by the inner's
      // own driver (carrier-independent), so the stock suspend arm classifies
      // it: a sync-settling inner yield advances in the same dispatch; a
      // genuinely-pending one (inner `yield await P`) suspends the OUTER frame
      // and the microtask drain resumes it — genuine two-level suspension.
      // `.throw()`/`.return()`/sent-value forwarding into the delegate are out
      // of scope (driven gens do not support them yet — #2906 3d-iii).
      const call = y.delegate;
      const helperName = delegates?.helperNameFor?.(call) ?? null;
      if (helperName === null) return null; // registry miss — gate/plan drift (unreachable post-gate)
      const iterSpillName = `__yieldstar_iter_${delegateIdx}`;
      delegateIdx += 1;
      const initId = id;
      const pumpId = id + 1;
      const chkId = id + 2;
      const yieldId = id + 3;
      const afterId = id + 4;

      // init: iter := inner(...) into the persisted per-delegate frame spill.
      const initEmit: AsyncCfgStepEmit = (ctx, fctx) => {
        const iterSlot = fctx.localMap.get(iterSpillName) ?? allocLocal(fctx, iterSpillName, { kind: "externref" });
        const srcType = compileExpression(ctx, fctx, call);
        if (srcType !== null && srcType !== undefined) {
          coerceType(ctx, fctx, srcType as ValType, { kind: "externref" });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        fctx.body.push({ op: "local.set", index: iterSlot });
      };

      // pump operand: push __async_gen_next_<inner>(iter) — the next()-promise.
      // funcIdx resolved fresh by NAME at emit (late imports shift defined idxs).
      const pumpOperand: AsyncCfgValueEmit = (ctx, fctx) => {
        const iterSlot = fctx.localMap.get(iterSpillName) ?? allocLocal(fctx, iterSpillName, { kind: "externref" });
        const nextIdx = ctx.funcMap.get(helperName);
        if (nextIdx === undefined) {
          // Unreachable: the drive gate required the helper to be registered.
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }
        fctx.body.push({ op: "local.get", index: iterSlot });
        fctx.body.push({ op: "call", funcIdx: nextIdx });
        return { kind: "externref" };
      };

      // chk: unpack the delivered IteratorResult (the resume binding local)
      // into transient done/value locals (same-dispatch use only — no spill).
      const unpackResult: AsyncCfgStepEmit = (ctx, fctx) => {
        const resultTypeIdx = ensureNativeGeneratorResultType(ctx, { kind: "externref" });
        const resSlot = fctx.localMap.get(YIELDSTAR_RESULT);
        const doneSlot = fctx.localMap.get(YIELDSTAR_DONE) ?? allocLocal(fctx, YIELDSTAR_DONE, { kind: "i32" });
        const valueSlot =
          fctx.localMap.get(YIELDSTAR_VALUE) ?? allocLocal(fctx, YIELDSTAR_VALUE, { kind: "externref" });
        if (resSlot === undefined) {
          // Unreachable: chk is the pump-suspend's resumeState, so the binding
          // local exists. Deliver done=1 so the loop exits rather than traps.
          fctx.body.push({ op: "i32.const", value: 1 });
          fctx.body.push({ op: "local.set", index: doneSlot });
          fctx.body.push({ op: "ref.null.extern" });
          fctx.body.push({ op: "local.set", index: valueSlot });
          return;
        }
        fctx.body.push({ op: "local.get", index: resSlot });
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "ref.cast", typeIdx: resultTypeIdx });
        fctx.body.push({ op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: RESULT_DONE_FIELD });
        fctx.body.push({ op: "local.set", index: doneSlot });
        fctx.body.push({ op: "local.get", index: resSlot });
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "ref.cast", typeIdx: resultTypeIdx });
        fctx.body.push({ op: "struct.get", typeIdx: resultTypeIdx, fieldIdx: RESULT_VALUE_FIELD });
        fctx.body.push({ op: "local.set", index: valueSlot });
      };

      const doneCond: AsyncCfgValueEmit = (_ctx, fctx) => {
        fctx.body.push({ op: "local.get", index: fctx.localMap.get(YIELDSTAR_DONE)! });
        return { kind: "i32" };
      };

      const yieldValue: AsyncCfgValueEmit = (_ctx, fctx) => {
        fctx.body.push({ op: "local.get", index: fctx.localMap.get(YIELDSTAR_VALUE)! });
        return { kind: "externref" };
      };

      states.push(
        {
          id: initId,
          resumeFrom: null,
          lead: asLead(y.leads),
          emit: initEmit,
          terminator: { kind: "goto", target: pumpId },
        },
        {
          id: pumpId,
          resumeFrom: null,
          lead: [],
          terminator: { kind: "suspend", awaited: { emit: pumpOperand }, resumeState: chkId, handler: 0 },
        },
        {
          id: chkId,
          resumeFrom: { binding: { name: YIELDSTAR_RESULT, type: undefined }, handler: 0 },
          lead: [],
          emit: unpackResult,
          terminator: { kind: "condGoto", cond: { emit: doneCond }, whenTrue: afterId, whenFalse: yieldId, handler: 0 },
        },
        {
          id: yieldId,
          resumeFrom: null,
          lead: [],
          terminator: { kind: "settleYield", value: { emit: yieldValue }, fromSent: false, resumeState: pumpId },
        },
      );
      id += 4;
      continue;
    }
    if (y.awaited !== null) {
      // await-suspend state → yield-from-sent state.
      states.push({
        id,
        resumeFrom: null,
        lead: asLead(y.leads),
        terminator: { kind: "suspend", awaited: y.awaited, resumeState: id + 1, handler: 0 },
      });
      states.push({
        id: id + 1,
        resumeFrom: { binding: null, handler: 0 }, // re-throw a rejected await
        lead: [],
        terminator: { kind: "settleYield", value: null, fromSent: true, resumeState: id + 2 },
      });
      id += 2;
    } else {
      states.push({
        id,
        resumeFrom: null,
        lead: asLead(y.leads),
        terminator: { kind: "settleYield", value: y.plain, fromSent: false, resumeState: id + 1 },
      });
      id += 1;
    }
  }
  states.push({ id, resumeFrom: null, lead: asLead(shape.tailLeads), terminator: { kind: "settleDone" } });
  return { states, handlers: [] };
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
 * Collect `for await (… of …)` loops (`ForOfStatement` with an `awaitModifier`)
 * in pre-order, not descending into nested fn scopes — a nested async fn's
 * for-await belongs to its own machine. (#2906 slice 3b)
 */
function collectForAwaitPoints(node: ts.Node, out: ts.ForOfStatement[]): void {
  if (isNestedFunctionScope(node)) return;
  if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
    out.push(node);
  }
  forEachChild(node, (child) => collectForAwaitPoints(child, out));
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
