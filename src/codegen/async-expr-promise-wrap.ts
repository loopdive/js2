// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4394) An async function EXPRESSION / arrow that the async engine DECLINED
 * must still return a Promise, and must still turn a synchronous throw into a
 * rejection.
 *
 * ## What was wrong
 *
 * Async-ness is applied at the CALL SITE (`wrapAsyncReturn` +
 * `wrapAsyncCallInTryCatch` in expressions.ts): the caller wraps the result in
 * `Promise.resolve` and re-emits the call inside a try/catch that converts a
 * throw into `Promise.reject`. That works whenever the call site can PROVE the
 * callee is async — a direct call to a declaration, or to a variable whose
 * initializer it can see.
 *
 * It cannot work for an INDIRECT call, which is the shape the harness uses:
 *
 * ```js
 * assert.throwsAsync = function (expectedErrorConstructor, func, message) {
 *   …
 *   try { res = func(); }                       // ← `func` is an untyped param
 *   catch (thrown) { fail(… + " but the function threw synchronously"); }
 * ```
 *
 * called as `assert.throwsAsync(Error, async function () { throw new Error(); })`.
 * Measured before this: `async function () { return 1; }` invoked through such a
 * parameter returned the NUMBER `1`, and `async function () { throw x; }` threw
 * SYNCHRONOUSLY — so `throwsAsync` reported "the function threw synchronously"
 * for a function that, per §27.7.5.1, cannot.
 *
 * ## Scope — deliberately the await-free subset
 *
 * Only a declined async closure whose body contains NO `await` is claimed.
 * That is precisely the population for which the legacy synchronous
 * pass-through is otherwise CORRECT except for the Promise envelope: with no
 * suspension point the body runs to completion synchronously, so wrapping its
 * completion in `Promise.resolve` / `Promise.reject` is the whole of the
 * remaining §27.7.5.1 obligation. A declined closure that DOES await still
 * compiles awaits as synchronous pass-throughs, and giving that a Promise
 * envelope would dress up a semantics gap the engine is separately closing
 * (#2957 / #3587) — so it is left exactly as it was.
 *
 * JS-host lane only: the standalone/WASI `$Promise` carrier has its own
 * activation rules (#2895 / #2980) and is untouched.
 *
 * ## Where the decision has to live
 *
 * In {@link computeClosureWrapperSig}, NOT at the closure-compile site. That
 * function is the SHARED signature oracle: the #2939 dynamic-dispatch candidate
 * PRE-SCAN (`calls.ts`) calls it to pre-register a wrapper type, and the real
 * compile calls it to mint the lifted func type. Deciding in only one of them
 * makes the two disagree, and an indirect `func()` then dispatches over a
 * candidate list that does not contain the closure's actual lifted type — the
 * call silently falls through to the host bridge and the throw escapes the
 * callee's `try` after all. That was measured: with the decision made only at
 * the compile site, a closure held in a VARIABLE worked and the same closure
 * passed INLINE as an argument did not.
 *
 * ## Why double-wrapping is safe
 *
 * A call site that CAN prove the callee is async still emits its own
 * `Promise.resolve`. That is idempotent — `Promise.resolve(p)` returns `p`
 * itself for a native promise (§27.2.4.7) — so the two wraps compose to one.
 */
import { ts } from "../ts-api.js";
import type { Instr } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureExnTag } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";

/**
 * Does this body contain a `try` of its own?
 *
 * The per-`return` wrap emits a wasm `return` directly, which unwinds past a
 * `finally` instead of running it. Measured: with `try` bodies admitted,
 * `language/expressions/async-arrow-function/try-return-finally-throw.js`
 * regressed pass → fail. Return-through-finally has its own replay machinery on
 * the engine path (`asyncDriveReturn.pendingFinalizer`); until this wrap
 * participates in it, a `try` body stays on the legacy lowering.
 */
function bodyHasOwnTry(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isTryStatement(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(fn, walk);
  return found;
}

/** Does this function body contain an `await` (or `for await`) of its own? */
function bodyHasOwnAwait(fn: ts.ArrowFunction | ts.FunctionExpression): boolean {
  let found = false;
  const walk = (node: ts.Node): void => {
    if (found) return;
    // A nested function has its own async context — its awaits are not ours.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isAwaitExpression(node)) {
      found = true;
      return;
    }
    if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) {
      found = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(fn, walk);
  return found;
}

/**
 * Should this closure's completion be wrapped in a Promise by the CALLEE?
 *
 * `asyncEngineClaimed` is the engine's verdict — when it claimed the closure its
 * state machine already produces a Promise and this must decline.
 *
 * Callers MUST agree: both `computeClosureWrapperSig` (signature) and
 * `compileClosureCore` (body emission) ask this, and a disagreement produces a
 * closure whose lifted type is absent from every dynamic-dispatch candidate
 * list. See the module header.
 */
export function asyncClosureNeedsPromiseWrap(
  ctx: CodegenContext,
  fn: ts.ArrowFunction | ts.FunctionExpression,
  isAsync: boolean,
  isGenerator: boolean,
  asyncEngineClaimed: boolean,
): boolean {
  if (!isAsync || isGenerator || asyncEngineClaimed) return false;
  if (ctx.standalone || ctx.wasi) return false;
  if (fn.body === undefined) return false;
  return !bodyHasOwnAwait(fn) && !bodyHasOwnTry(fn);
}

/**
 * Emit `Promise.resolve(<externref on stack>)`. The caller has already coerced
 * the completion value to externref. Returns false when the import is
 * unavailable, in which case nothing was emitted.
 */
export function emitPromiseResolveWrap(ctx: CodegenContext, fctx: FunctionContext): boolean {
  const resolveIdx = ensureLateImport(ctx, "Promise_resolve", [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (resolveIdx === undefined) return false;
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("Promise_resolve") ?? resolveIdx });
  return true;
}

/**
 * Splice everything the lifted body emitted from `start` and re-emit it inside
 * a `try` whose handlers convert a synchronous throw into `Promise.reject`.
 *
 * A wasm `return` inside the `try` unwinds straight out of the function, so the
 * per-`return` `Promise.resolve` wrap (`compileReturnStatement`'s first arm) is
 * what covers the explicit-return paths; this covers the fall-through
 * completion and every throw. Mirrors `wrapAsyncCallInTryCatch`'s handler pair:
 * the module's own `$exn` tag carries the thrown JS value as its payload, and
 * `catch_all` stays as the reason-less fallback for a foreign exception.
 */
export function wrapLiftedAsyncBodyInPromise(ctx: CodegenContext, fctx: FunctionContext, start: number): void {
  const rejectIdx = ensureLateImport(ctx, "Promise_reject", [{ kind: "externref" }], [{ kind: "externref" }]);
  const getCaughtIdx = ensureLateImport(ctx, "__get_caught_exception", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (rejectIdx === undefined || getCaughtIdx === undefined) return;
  const reject = ctx.funcMap.get("Promise_reject") ?? rejectIdx;
  const getCaught = ctx.funcMap.get("__get_caught_exception") ?? getCaughtIdx;
  const tagIdx = ensureExnTag(ctx);
  const inner = fctx.body.splice(start);
  const catchExn: Instr[] = [{ op: "call", funcIdx: reject }];
  const catchAll: Instr[] = [
    { op: "call", funcIdx: getCaught },
    { op: "call", funcIdx: reject },
  ];
  fctx.body.push({
    op: "try",
    blockType: { kind: "val", type: { kind: "externref" } },
    body: inner,
    catches: [{ tagIdx, body: catchExn }],
    catchAll,
  });
}
