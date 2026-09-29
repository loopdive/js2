// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2865 AG0 / #6428) Native-`$Promise` unwrap at a consuming site.
 *
 * Two callers, one lowering:
 *   - {@link emitStandaloneAwaitUnwrap} — the `await` operand unwrap, moved here
 *     out of `expressions.ts` (the #3102 god-file) unchanged.
 *   - {@link emitAsyncValueSinkUnwrap} — the #6428 raw-VALUE-sink half of the
 *     same contract.
 */
import type { AsyncConsumerKind } from "./async-cps.js";
import type { Instr, ValType } from "../ir/types.js";
import { getOrRegisterPromiseType, isStandalonePromiseActive } from "./async-scheduler.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { InnerResult } from "./shared.js";
import { VOID_RESULT } from "./shared.js";

/**
 * (#2865 AG0) Emit a one-level native-`$Promise` await unwrap, host-free.
 * Consumes one externref on the stack and leaves one externref:
 *   - if it is a `$Promise` struct → push its `value` field (the resolved
 *     value the awaiter wants);
 *   - otherwise → push the original externref unchanged (a plain value / a
 *     non-Promise thenable is already "the value" under the standalone
 *     synchronous-settlement model).
 *
 * A runtime `ref.test (ref $Promise)` discriminates — the non-null test means a
 * null externref (or any non-`$Promise`) takes the passthrough arm. This fixes
 * the standalone identity-passthrough NaN bug (`await <fulfilled $Promise>`
 * previously returned the promise object itself, which the consumer coerced to
 * f64 → NaN). Genuinely-pending awaits (a promise that only settles on a later
 * microtask) need true frame suspension — deferred to #2865 AG1 (PATH B).
 *
 * `src/ir/lower-generic.ts`'s `await` arm mirrors this EXACTLY — keep the two in
 * lockstep (see `ir/backend/lower-contracts.ts` L272).
 */
export function emitStandaloneAwaitUnwrap(ctx: CodegenContext, fctx: FunctionContext): void {
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const tmp = allocTempLocal(fctx, { kind: "externref" });
  // stack: externref(operand) → stash, then test the stashed copy.
  fctx.body.push({ op: "local.set", index: tmp });
  fctx.body.push({ op: "local.get", index: tmp });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: promiseTypeIdx });
  const thenBody: Instr[] = [
    { op: "local.get", index: tmp },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: promiseTypeIdx },
    // $Promise field 1 = `value` (externref). See getOrRegisterPromiseType.
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
  ];
  const elseBody: Instr[] = [{ op: "local.get", index: tmp }];
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: thenBody,
    else: elseBody,
  });
  releaseTempLocal(fctx, tmp);
}

/**
 * (#6428) Standalone/WASI value-sink half of §27.7.5.2 + §27.2.1.3.2.
 *
 * #5371 fixed the RESULT-CARRIER half: an async callee whose body can `return`
 * a thenable now hands back an **externref** (a real native `$Promise` on the
 * carrier lane) instead of a raw f64. On the host lane the call site's adopting
 * `Promise.resolve` settles with the inner value, so the answer is right. On the
 * host-free carrier lane there is no host adopt: the raw-value sink
 * (`f() as unknown as number`, #1727) coerced that `$Promise` externref straight
 * to f64 → `NaN`.
 *
 * Called from the non-`thenable` arm of the async-call consumer dispatch in
 * `expressions.ts` with the call's result still on the stack. When the consumer
 * kind is `value`, the carrier is active and the result is an externref, emit
 * the same one-level unwrap the `await` consumer already performs at its own
 * site; otherwise leave the stack untouched and hand `callResult` back. The
 * `ref.test $Promise` guard inside {@link emitStandaloneAwaitUnwrap} makes it a
 * no-op for any other externref (a `Promise<string>` callee's string passes
 * through), so no other value sink moves.
 *
 * `await` consumers are deliberately excluded — they unwrap at their own site
 * and must stay byte-identical. Off the carrier (gc/host) the gate is false, so
 * the host ABI is untouched.
 */
export function emitAsyncValueSinkUnwrap(
  ctx: CodegenContext,
  fctx: FunctionContext,
  consumerKind: AsyncConsumerKind,
  callResult: InnerResult,
): InnerResult {
  if (consumerKind !== "value") return callResult;
  if (!isStandalonePromiseActive(ctx)) return callResult;
  if (callResult === null || callResult === VOID_RESULT) return callResult;
  if ((callResult as ValType).kind !== "externref") return callResult;
  emitStandaloneAwaitUnwrap(ctx, fctx);
  return { kind: "externref" };
}
