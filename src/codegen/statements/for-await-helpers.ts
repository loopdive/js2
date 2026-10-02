// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * `for await` synchronous-drive helpers (#2978): per-element Await unwrap under
 * the native $Promise carrier (§27.1.4.4 AsyncFromSyncIteratorContinuation:
 * REJECTED→throw, FULFILLED→unwrap, PENDING→leave), the host-lane element
 * mark-handled (#6791) and the iteration step-cap. Emitted by the for-of
 * drivers in loops.ts, which import them back.
 */
import type { ValType } from "../../ir/types.js";
import type { ts } from "../../ts-api.js";
import {
  getOrRegisterPromiseType,
  isStandalonePromiseActive,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_REJECTED,
} from "../async-scheduler.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitThrowTypeError } from "../expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts } from "../expressions/late-imports.js";
import { ensureExnTag } from "../registry/imports.js";
import { collectInstrs } from "./shared.js";

/**
 * (#2978) Iteration ceiling for `for await` loops that are driven by the
 * SYNCHRONOUS for-of machinery (no CPS/frame suspension — the async fn compiled
 * as a sync body). On these drives a genuinely-pending or host-carrier promise
 * element can NEVER be observed settling (a JS host promise's state is not
 * synchronously readable, and the sync body cannot yield to the microtask
 * queue), so an iterator that never reports `done` re-enters `next()` forever,
 * allocating a promise per step — measured ~3 GB JS heap in ~14 s before V8's
 * OOM kill, which can take a CI shard worker down with it (issue #2978).
 *
 * The cap converts that unbounded loop into a LOUD, bounded TypeError that
 * still routes through IteratorClose (`return()` fires exactly once, and the
 * enclosing `try/catch` observes the abrupt completion). It fires only on
 * `for await` sync drives — plain `for..of` loops are uncapped (#2067) — and
 * only after 100k steps, far beyond any legitimate sync-iterable length in
 * practice. It is a transitional guard: rejected native-`$Promise` elements
 * are handled spec-correctly before the cap can trigger (see
 * `emitForAwaitElementUnwrap`), and the remaining pending-promise shapes move
 * to the real #2895 frame-suspension drive as it widens, after which this cap
 * is dead code on those lanes.
 */
const FOR_AWAIT_SYNC_DRIVE_STEP_CAP = 100_000;

/**
 * (#2978) Emit the per-element `Await` for a `for await` loop driven by the
 * synchronous for-of machinery, under the native `$Promise` carrier
 * (`isStandalonePromiseActive` — wasi today, `--target standalone` after the
 * #2980 widen). Spec §27.1.4.4 `AsyncFromSyncIteratorContinuation`: the sync
 * iterator's `value` is wrapped via `PromiseResolve`; a REJECTED wrapper must
 * reject the step, which closes the sync iterator and completes the loop
 * abruptly with the rejection reason.
 *
 * `valueLocal` holds the just-read element (externref — the boxed-any rep the
 * native carrier uses for promise values). Emits:
 *   - value is a `$Promise` (ref.test after `any.convert_extern`):
 *       state == REJECTED  → `throw` the reason (field 1) via the shared exn
 *                            tag. The CALLER is responsible for close-on-throw
 *                            (the `__iterator` path's #1347 try/catch_all, or
 *                            the direct path's #2978 wrapper) so `return()`
 *                            fires exactly once before the rethrow reaches the
 *                            user `catch`.
 *       state == FULFILLED → unwrap one level: valueLocal = promise.value
 *                            (AG0-consistent single unwrap).
 *       state == PENDING   → leave the promise as the value (the sync drive
 *                            cannot suspend — the #2895 AG0 limitation; the
 *                            step cap bounds the pathological infinite case).
 *   - not a `$Promise` → no-op (`Await(v) = v` for settled plain values).
 *
 * The promise ref is narrowed ONCE into a typed local and re-read from there
 * (repeated `any.convert_extern; ref.cast` chains confuse the stack-balance
 * type-repair pass — the #2895 slice-1b lesson).
 */
export function emitForAwaitElementUnwrap(ctx: CodegenContext, fctx: FunctionContext, valueLocal: number): void {
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const tagIdx = ensureExnTag(ctx);
  const pLocal = allocLocal(fctx, `__forawait_p_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: promiseTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: valueLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: promiseTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // Narrow once into the typed local.
      { op: "local.get", index: valueLocal },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: promiseTypeIdx },
      { op: "local.set", index: pLocal },
      // state == REJECTED → throw the reason (abrupt loop completion).
      { op: "local.get", index: pLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: PROMISE_STATE_REJECTED },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: pLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
          { op: "throw", tagIdx },
        ],
        else: [
          // state == FULFILLED → unwrap one level.
          { op: "local.get", index: pLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
          { op: "i32.const", value: PROMISE_STATE_FULFILLED },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: pLocal },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
              { op: "local.set", index: valueLocal },
            ],
            else: [], // PENDING — leave as-is (see doc comment).
          },
        ],
      },
    ],
    else: [],
  });
}

/**
 * (#2978) Emit the per-iteration step-cap check for a `for await` sync drive.
 * Must be pushed at the TOP of the loop body (before the `next()` call) so
 * `continue` still passes through it. The counter local must be zero-initialised
 * immediately before the loop is entered (locals are only zeroed at function
 * entry — a re-entered loop must not inherit the previous run's count, the
 * #2067 accumulation bug).
 */
export function emitForAwaitStepCapCheck(ctx: CodegenContext, fctx: FunctionContext, capLocal: number): void {
  const throwInstrs = collectInstrs(fctx, () =>
    emitThrowTypeError(
      ctx,
      fctx,
      "for await: iteration limit exceeded (async carrier cannot observe promise settlement on this target — #2978)",
    ),
  );
  fctx.body.push({ op: "local.get", index: capLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.tee", index: capLocal });
  fctx.body.push({ op: "i32.const", value: FOR_AWAIT_SYNC_DRIVE_STEP_CAP });
  fctx.body.push({ op: "i32.gt_u" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: throwInstrs,
    else: [],
  });
}

/**
 * (#2978) Allocate and zero the `for await` step counter immediately before the
 * loop (see `emitForAwaitStepCapCheck`); -1 when the loop is not `for await`.
 */
export function initForAwaitStepCap(fctx: FunctionContext, isForAwait: boolean): number {
  if (!isForAwait) return -1;
  const capLocal = allocLocal(fctx, `__forawait_steps_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: capLocal });
  return capLocal;
}

/** (#6791) Host import that marks a `for await` sync-drive element handled. */
const FOR_AWAIT_MARK_HANDLED = "__forawait_mark_handled";

/**
 * (#6791) A `for await` driven SYNCHRONOUSLY on the JS-host promise lane binds
 * each element without awaiting it (the sync body cannot yield), where natively
 * the loop's Await reacts to every element promise. A rejected element the drive
 * drops — one per step of a capped #2978 loop — must not surface as a host
 * unhandled rejection the native program never has. The runtime used to mask
 * this by pre-marking EVERY `Promise.reject` result handled, which also silenced
 * rejections the program itself drops. The native `$Promise` carrier awaits
 * elements itself (`emitForAwaitElementUnwrap`) and standalone/WASI have no host
 * rejection tracker, so only the host lane marks.
 */
function hostLaneForAwait(ctx: CodegenContext, stmt: ts.ForOfStatement): boolean {
  return !!stmt.awaitModifier && !ctx.standalone && !ctx.wasi && !isStandalonePromiseActive(ctx);
}

/**
 * (#6791) Register the mark-handled import for a host-lane `for await`. Call it
 * before a driver captures any function index — a late import shifts them.
 */
export function ensureForAwaitMarkHandled(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForOfStatement): void {
  if (!hostLaneForAwait(ctx, stmt)) return;
  ensureLateImport(ctx, FOR_AWAIT_MARK_HANDLED, [{ kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
}

/**
 * (#6791) Mark the element on top of the stack handled (a pass-through call) on
 * a host-lane `for await` whose element is an externref; no-op otherwise.
 */
export function emitForAwaitMarkHandled(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  elemType: ValType,
): void {
  if (elemType.kind !== "externref" || !hostLaneForAwait(ctx, stmt)) return;
  const markIdx = ctx.funcMap.get(FOR_AWAIT_MARK_HANDLED);
  if (markIdx !== undefined) fctx.body.push({ op: "call", funcIdx: markIdx });
}

/**
 * Per-element `for await` handling of the element on top of the stack in the
 * direct struct-iterator drive: the carrier Await (#2978) or the host-lane
 * mark-handled (#6791). Leaves the (possibly unwrapped) element on the stack.
 */
export function emitForAwaitStackElement(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  elemType: ValType,
  carrierAwait: boolean,
): void {
  if (!carrierAwait) {
    emitForAwaitMarkHandled(ctx, fctx, stmt, elemType);
    return;
  }
  const awaitTmp = allocLocal(fctx, `__forawait_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: awaitTmp });
  emitForAwaitElementUnwrap(ctx, fctx, awaitTmp);
  fctx.body.push({ op: "local.get", index: awaitTmp });
}
