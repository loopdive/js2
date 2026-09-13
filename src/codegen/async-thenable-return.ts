// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5371) `return <thenable>` from an async function that never suspends.
 *
 * §27.7.5.2 AsyncFunctionStart resolves the function's promise capability with
 * the return value, and §27.2.1.3.2 makes a thenable result ADOPT — so
 * `async function w() { return hostFn(); }` fulfils with 11, not with the
 * promise `hostFn()` returned.
 *
 * An async function that genuinely suspends is drive-lowered and already
 * settles its result promise through the adopting path. Every other async
 * shape stays on the legacy SYNCHRONOUS pass-through, whose wasm result is the
 * UNWRAPPED `T` (`unwrapPromiseType(Promise<number>)` → `f64`) and whose
 * Promise is minted at the call site (`wrapAsyncReturn`). That is exactly
 * where the value was destroyed: the body's `return hostFn()` leaves a Promise
 * **externref** on the stack and the return coercion runs
 * `externref → f64` — `Number(Promise{11})` — so the caller's `await` read
 * **NaN**.
 *
 * The information loss is in the CARRIER, not in the adoption: when the
 * unwrapped `T` is already externref-carried the same body is correct today
 * (`async function h() { return hostStr(); }` measured PASS on the parent,
 * because `Promise<string>` unwraps to an externref-carried `string` and
 * `wrapAsyncReturn`'s `Promise.resolve` adopts the thenable for free).
 *
 * So the repair is one rule at the ABI: a legacy-pass-through async function
 * whose own body can `return` a thenable keeps its result on the **externref**
 * carrier, and the existing adopting `Promise.resolve` at the call site does
 * the §27.2.1.3.2 work. Nothing else changes — the widening fires only when a
 * return operand's type actually carries a `then`, so an async function
 * returning a plain value (the overwhelming majority) is byte-identical.
 *
 * Measured on the parent (2026-09-12, host lane, `.js` two-file project):
 * `async function a() { return hostNum(); }` → NaN; the same body behind a
 * `const p = hostNum(); return p;` local, an `if`-guarded arm, an async arrow,
 * an object-literal async method and a compiled-async callee all → NaN; the
 * suspending sibling (`await hostNum(); return hostNum();`) already PASSed.
 */
import { forEachChild, ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { asyncEngineWouldActivate } from "./async-activation.js";

/** Per-context memo — the body walk is O(body) and every declaration asks once per registration site. */
const thenableReturnCache = new WeakMap<CodegenContext, WeakMap<ts.Node, boolean>>();

function isNestedFunctionScope(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

/**
 * Does `expr`'s type carry a `then` member — i.e. is it a Promise or a custom
 * thenable? Routed through the oracle so the answer is the registry-free fact,
 * not a raw `ts.Type` identity question. `any`/`unknown` have no resolvable
 * `then` and answer `false`: they are already externref-carried, so the
 * widening would be a no-op for them anyway.
 */
function expressionIsThenable(ctx: CodegenContext, expr: ts.Expression): boolean {
  return ctx.oracle.propertyFactOf(expr, "then").kind !== "unresolvable";
}

/**
 * Can this async function's own body `return` a thenable? Concise arrow bodies
 * count as the single return operand; nested function scopes are skipped (their
 * returns settle their OWN promise).
 */
function asyncBodyReturnsThenable(ctx: CodegenContext, fn: ts.FunctionLikeDeclaration): boolean {
  const perCtx = thenableReturnCache.get(ctx) ?? new WeakMap<ts.Node, boolean>();
  thenableReturnCache.set(ctx, perCtx);
  const memo = perCtx.get(fn);
  if (memo !== undefined) return memo;

  let found = false;
  const body = fn.body;
  if (body !== undefined && (fn as { asteriskToken?: ts.Node }).asteriskToken === undefined) {
    if (!ts.isBlock(body)) {
      found = expressionIsThenable(ctx, body);
    } else {
      const walk = (node: ts.Node): void => {
        if (found || isNestedFunctionScope(node)) return;
        if (ts.isReturnStatement(node) && node.expression !== undefined && expressionIsThenable(ctx, node.expression)) {
          found = true;
          return;
        }
        // #3437: the shared helper keeps this per-body scan on the compile-work meter.
        forEachChild(node, walk);
      };
      forEachChild(body, walk);
    }
  }
  perCtx.set(fn, found);
  return found;
}

/** Is `fn` an `async` non-generator function-like? */
function isAsyncNonGenerator(fn: ts.FunctionLikeDeclaration): boolean {
  if ((fn as { asteriskToken?: ts.Node }).asteriskToken !== undefined) return false;
  return (fn.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/**
 * The one ABI rule (see the module header): keep a legacy-pass-through async
 * function's result on the externref carrier when its body can return a
 * thenable. A `void`/absent result and an already-externref result are left
 * exactly as they were, so the emitted bytes move only for the shapes that
 * were reading NaN.
 */
export function widenAsyncThenableResult(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
  result: ValType | null,
): ValType | null {
  if (result === null || result.kind === "externref") return result;
  if (!isAsyncNonGenerator(fn)) return result;
  if (!asyncBodyReturnsThenable(ctx, fn)) return result;
  return { kind: "externref" };
}

/** {@link widenAsyncThenableResult} over a wasm results tuple. */
export function widenAsyncThenableResults(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
  results: ValType[],
): ValType[] {
  if (results.length !== 1) return results;
  const widened = widenAsyncThenableResult(ctx, fn, results[0]!);
  return widened === results[0] ? results : [widened!];
}

/**
 * (#6412) Bake the Promise CARRIER into an engine-activated async declaration's
 * result at DECLARATION time.
 *
 * `maybeActivateAsync` rewrites an activated async function's registered result
 * to `externref` only when that function's own BODY compiles. A caller compiled
 * earlier — i.e. one that textually PRECEDES the callee — reads the stale
 * unwrapped-`Promise<T>` result through `funcSignatureOf` and wraps the call in
 * `extern.convert_any` to feed its `await`; the later rewrite then leaves
 * `extern.convert_any (call $callee)` over an already-`externref` value, which
 * the engine rejects (`expected type anyref, found call of type externref` —
 * hono's `importPublicKey` → `exportPublicJwkFrom`). Deciding the carrier here
 * makes the registered signature declaration-ORDER independent.
 *
 * Call it AFTER `prepareAsyncCallableAbi` / {@link widenAsyncThenableResults}
 * so the prepared-IR ABI fingerprint still sees the fulfillment results.
 */
export function bakeActivatedAsyncPromiseResult(
  ctx: CodegenContext,
  fn: ts.FunctionLikeDeclaration,
  results: ValType[],
): ValType[] {
  if (!isAsyncNonGenerator(fn)) return results;
  if (!asyncEngineWouldActivate(ctx, fn)) return results;
  return [{ kind: "externref" }];
}
