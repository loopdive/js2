// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1326 Phase 1A — Async standalone microtask queue + Promise GC struct.
// #1326 Phase 1C-A — Microtask queue infrastructure + drain export.
//
// This module provides the foundation for running Promise/async code through
// the native semantic provider (including standalone/WASI and native-first JS
// environments) without JS-host semantic imports. The full Phase 1 is
// decomposed into 4 sub-slices (see issue file `## Implementation Plan`):
//
//   1A   (shipped): scaffold + type-registry + stubbed emit helpers
//   1B   (shipped): $Promise struct registry + Promise.resolve/reject
//   1C-A (shipped): microtask queue (WasmGC funcref+externref arrays) +
//                   __microtask_enqueue / __drain_microtasks helpers +
//                   __drain_microtasks export + WASI _start auto-drain
//   1C-B (this PR): Promise.then standalone — synthesised continuation
//                   wrappers, chained-resolution machinery, rejection
//                   propagation.

import type { Instr, LocalDef, ValType } from "../ir/types.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addFuncType, getOrRegisterArrayType } from "./registry/types.js";
import { addUnionImportsViaRegistry, ensureLateImport, flushLateImportShifts } from "./shared.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { inLiveShiftRange } from "../emit/resolve-layout.js"; // (#1916 S3) stable handles never shift
// (#3125) Thenable-assimilation substrate deps. `closures.js` ← here is an
// eval-time-SAFE cycle (closures.ts imports `isStandalonePromiseActive` from
// this module; both bindings are only dereferenced inside function bodies,
// never at module evaluation). The other three are cycle-free leaves relative
// to this module.
import { getClosureFuncSelfTypeIdx, getOrCreateFuncRefWrapperTypes } from "./closures.js";
import {
  CLOSURE_CAPTURE_FIELD_BASE,
  closureArityField,
  closureBagField,
  closureBagInitInstr,
} from "./closures/funcref-wrapper-types.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { reserveClosedMethodDispatchVararg } from "./closed-method-dispatch.js";
// (#4394) Dynamic `.then` handler wrappers invoke a runtime-held callback via
// the `__apply_closure` arity bridge; the args carrier is the runtime's own
// $ObjVec. Cycle-safe: object-runtime.ts does not import this module.
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { getFuncRefWrapperRootTypeIdx } from "./closures/funcref-wrapper-types.js";
// (#2958, extracted for #3102) The unhandled-rejection substrate lives in its own
// module; the inline hooks in this file (settle-body note, Promise.reject mint)
// call these two. `ensureUnhandledRejectionReporter` is imported by index.ts.
import { ensureUnhandledRejectionTracking, buildNoteUnhandledRejection } from "./unhandled-rejection.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";

/**
 * #1326 — Sentinel state values for `$Promise.state`. Match the JS spec
 * tri-state: pending → fulfilled (final), or pending → rejected (final).
 * State transitions other than from pending are illegal per spec and
 * silently ignored by Phase 1B's resolve/reject emit code.
 */
export const PROMISE_STATE_PENDING = 0;
export const PROMISE_STATE_FULFILLED = 1;
export const PROMISE_STATE_REJECTED = 2;

/**
 * #1326 — Default microtask queue capacity. The Phase 1C-A queue is a pair
 * of WasmGC arrays (one funcref, one externref) sized at allocation time
 * and grown via `__microtask_grow` on overflow. 8,192 slots covers typical
 * async kernels (most chains are <100 entries deep) without forcing a grow
 * on first use.
 */
export const MICROTASK_QUEUE_INITIAL_SLOTS = 8192;

/**
 * #1326 — Shared per-context state for the async scheduler. Cached on
 * `ctx.asyncScheduler` (created lazily on first access) so 1B/1C
 * emitters share registered indices without re-registering.
 *
 * Phase 1C-A populates the queue infrastructure fields lazily on the first
 * `ensureMicrotaskQueue` call. Phase 1C-B will add wrapper-cache fields.
 */
export interface AsyncSchedulerState {
  /** $Promise WasmGC struct typeIdx, or -1 until registered (Phase 1A). */
  promiseTypeIdx: number;
  /** $__arr_externref typeIdx (queue captures + args buffer, Phase 1A). */
  microtaskArgsArrTypeIdx: number;
  /** $__arr_mt_func typeIdx — funcref array for queued callbacks. -1 until queue is registered. */
  microtaskFuncArrTypeIdx: number;
  /** $__mt_func_type typeIdx — `(externref, externref) → externref`, the uniform wrapper signature. -1 until queue is registered. */
  microtaskFuncTypeIdx: number;
  /** Wasm global index for the queue head pointer (next entry to drain). -1 until registered. */
  microtaskHeadGlobalIdx: number;
  /** Wasm global index for the queue tail pointer (next free slot). -1 until registered. */
  microtaskTailGlobalIdx: number;
  /** Wasm global index for the queue's current capacity. -1 until registered. */
  microtaskCapGlobalIdx: number;
  /** Wasm global index for the funcref array (or ref.null until allocated). -1 until registered. */
  microtaskFuncsGlobalIdx: number;
  /** Wasm global index for the captures array. -1 until registered. */
  microtaskCapsGlobalIdx: number;
  /** Wasm global index for the args array. -1 until registered. */
  microtaskArgsGlobalIdx: number;
  /** Function index of `__microtask_enqueue(funcref, externref, externref)`. -1 until registered. */
  enqueueFuncIdx: number;
  /** Function index of `__drain_microtasks()`. -1 until registered. */
  drainFuncIdx: number;
  /** Function index of `__microtask_grow(i32)`. -1 until registered. */
  growFuncIdx: number;
  /** `$PromiseCallback` pending-callback linked-list node type. -1 until registered. */
  promiseCallbackTypeIdx: number;
  /** `$__then_caps` task-captures type (`callback`, `chained`). -1 until registered. */
  thenCapsTypeIdx: number;
  /** Function index of `__promise_fulfill((ref $Promise), externref) -> externref`. */
  promiseFulfillFuncIdx: number;
  /** Function index of `__promise_reject((ref $Promise), externref) -> externref`. */
  promiseRejectFuncIdx: number;
  /** Function index of the identity fulfillment task wrapper. */
  identityFulfillWrapperFuncIdx: number;
  /** Function index of the identity rejection task wrapper. */
  identityRejectWrapperFuncIdx: number;
  /**
   * Function index of `__promise_resolve_value((ref $Promise), externref) ->
   * externref` — the spec "Resolve(promise, value)" primitive (#2867 Gap 1).
   * If `value` is itself a native `$Promise` (the result of an async-fn call or
   * a `.then` handler that returns a promise), the chained promise ADOPTS that
   * inner promise's eventual state (recursive thenable assimilation) instead of
   * fulfilling with the promise object. Otherwise it fulfils directly — so it is
   * a drop-in for `__promise_fulfill` at every settle-with-handler-result site.
   */
  promiseResolveValueFuncIdx: number;
  /** Counter for generated `__then_fulfill_N` / `__then_reject_N` wrappers. */
  thenWrapperCounter: number;
  /** Whether `__drain_microtasks` has been added to the module's exports. */
  drainExported: boolean;

  // ── (#2958) standalone/WASI unhandled-rejection tracking ───────────────────
  /**
   * `$__unhandled_node { promise (ref null eq), next externref, handled i32 (mut) }`
   * typeIdx — an intrusive singly-linked list node recording a promise that
   * rejected with NO reaction at settle time. -1 until registered (wasi-only).
   */
  unhandledNodeTypeIdx: number;
  /**
   * Wasm global (externref) — head of the `$__unhandled_node` list. Each node is
   * prepended on a handler-less rejection (O(1)); the exit-time reporter walks it.
   * -1 until registered.
   */
  unhandledHeadGlobalIdx: number;
  /**
   * Func idx of `__mark_rejection_handled(p eqref)` — walk the list and flag the
   * node whose promise is `p` as handled, so the reporter skips it. -1 until registered.
   */
  markRejectionHandledFuncIdx: number;

  // ── (#2903) native `Promise.prototype.finally` runtime (§27.2.5.3) ──────
  /** `$__finally_restore_caps { chained (ref $Promise), value externref, isReject i32 }` typeIdx. -1 until registered. */
  finallyRestoreCapsTypeIdx: number;
  /** Func idx of `__finally_restore_settle(caps, _) -> externref` — re-settles `chained` with the ORIGINAL value/reason. -1 until registered. */
  finallyRestoreSettleFuncIdx: number;
  /** Func idx of `__finally_restore_reject(caps, reason) -> externref` — onFinally's result rejected: override with ITS reason. -1 until registered. */
  finallyRestoreRejectFuncIdx: number;
  /** Func idx of `__finally_after(result, chained, value, isReject)` — PromiseResolve(onFinally()) then restore. -1 until registered. */
  finallyAfterFuncIdx: number;

  // ── #2632 Phase 1 — timer heap + run-loop reactor ──────────────────────
  /** `$__arr_timer_func` funcref-array typeIdx (timer callback storage). -1 until registered. */
  timerFuncArrTypeIdx: number;
  /** `$__arr_i64` i64-array typeIdx (timer deadlines + interval periods). -1 until registered. */
  timerI64ArrTypeIdx: number;
  /** `$__arr_i32` i32-array typeIdx (timer cancelled flags). -1 until registered. */
  timerI32ArrTypeIdx: number;
  /** Wasm global: count of live timer slots (high-water; cancelled lazily). -1 until registered. */
  timerCountGlobalIdx: number;
  /** Wasm global: current capacity of the timer arrays. -1 until registered. */
  timerCapGlobalIdx: number;
  /** Wasm global: deadlines i64 array (ref.null until first add). -1 until registered. */
  timerDeadlinesGlobalIdx: number;
  /** Wasm global: callbacks funcref array. -1 until registered. */
  timerCallbacksGlobalIdx: number;
  /** Wasm global: captures externref array. -1 until registered. */
  timerCapturesGlobalIdx: number;
  /** Wasm global: interval periods i64 array (0 = one-shot). -1 until registered. */
  timerIntervalsGlobalIdx: number;
  /** Wasm global: cancelled i32 flags array. -1 until registered. */
  timerCancelledGlobalIdx: number;
  /** Func idx of `__timer_add(deadlineNs i64, cb funcref, cap externref, intervalNs i64) -> i32`. -1 until registered. */
  timerAddFuncIdx: number;
  /** Func idx of `__timer_cancel(id i32)`. -1 until registered. */
  timerCancelFuncIdx: number;
  /** Func idx of `__timer_peek_deadline() -> i64` (i64 max when none pending). -1 until registered. */
  timerPeekDeadlineFuncIdx: number;
  /** Func idx of `__timer_fire_due(nowNs i64)` — fires all due timers, re-arms intervals. -1 until registered. */
  timerFireDueFuncIdx: number;
  /** Func idx of `__run_event_loop()` — the reactor driver. -1 until registered. */
  runLoopFuncIdx: number;
  /** Func idx of the monotonic-now reader `__rl_now_ns() -> i64` (CLOCK_MONOTONIC). -1 until registered. */
  runLoopNowFuncIdx: number;
  /** Whether the timer heap was ever registered (drives run-loop emission + _start wiring). */
  timerHeapRegistered: boolean;

  // ── #2632 Phase 2 — fd-readiness reactor (fd0 + internal stdin buffer) ──
  /**
   * Whether the run loop should wait on fd0-readable OR the nearest timer
   * (multi-subscription `poll_oneoff`) instead of the Phase-1 single-clock
   * sleep, and drain fd0 into an internal stdin buffer each tick. Set BEFORE
   * `ensureTimerHeap` runs so the run-loop body is built in the fd-reactor
   * shape. When false, the run loop is byte-identical to Phase 1.
   */
  stdinReactor: boolean;
  /** Wasm global: 1 once fd0's non-blocking flag has been set (set-once guard). -1 until registered. */
  stdinNonblockSetGlobalIdx: number;
  /** Wasm global: 1 while fd0 is still subscribed (not at EOF); 0 after EOF. -1 until registered. */
  stdinFdActiveGlobalIdx: number;
  /** Wasm global: byte count currently buffered in the internal stdin region (write cursor). -1 until registered. */
  stdinBufLenGlobalIdx: number;
  /** Wasm global: read cursor into the internal stdin region (Phase-3 consumer advances it). -1 until registered. */
  stdinBufPosGlobalIdx: number;
  /** Func idx of `__rl_stdin_drain() -> i32` — fd_read available bytes into the internal buffer; returns bytes read (0 = EOF). -1 until registered. */
  stdinDrainFuncIdx: number;
  /** Func idx of `__rl_poll_fd0_or_clock(deadlineNs i64, nowNs i64) -> i32` — 1 if fd0 readable, 0 if timeout/no-fd. -1 until registered. */
  pollFd0OrClockFuncIdx: number;

  // ── #2632 Phase 3 — process.stdin Readable reactor-tick hook ──
  /**
   * Wasm global (nullable funcref, `$__mt_func_type` signature): the
   * `process.stdin` Readable's "pump" callback. The run loop calls it once per
   * tick AFTER `__rl_stdin_drain` fills the internal buffer (so the pump runs as
   * loop work, not synchronously inside `poll_oneoff`). Null until the library
   * registers a reader via `__wasiStdinSetReader(cb)`. -1 until registered.
   */
  stdinReaderHookGlobalIdx: number;
  /**
   * Wasm global (externref): the closure-captures struct for the reader hook
   * (the bound Readable instance). The run loop passes it as the hook's first
   * arg so the pump can reach its `this`. -1 until registered.
   */
  stdinReaderCapGlobalIdx: number;
}

export function getOrInitState(ctx: CodegenContextWithScheduler): AsyncSchedulerState {
  if (!ctx.asyncScheduler) {
    ctx.asyncScheduler = {
      promiseTypeIdx: -1,
      microtaskArgsArrTypeIdx: -1,
      microtaskFuncArrTypeIdx: -1,
      microtaskFuncTypeIdx: -1,
      microtaskHeadGlobalIdx: -1,
      microtaskTailGlobalIdx: -1,
      microtaskCapGlobalIdx: -1,
      microtaskFuncsGlobalIdx: -1,
      microtaskCapsGlobalIdx: -1,
      microtaskArgsGlobalIdx: -1,
      enqueueFuncIdx: -1,
      drainFuncIdx: -1,
      growFuncIdx: -1,
      promiseCallbackTypeIdx: -1,
      thenCapsTypeIdx: -1,
      promiseFulfillFuncIdx: -1,
      promiseRejectFuncIdx: -1,
      identityFulfillWrapperFuncIdx: -1,
      identityRejectWrapperFuncIdx: -1,
      promiseResolveValueFuncIdx: -1,
      thenWrapperCounter: 0,
      drainExported: false,
      unhandledNodeTypeIdx: -1,
      unhandledHeadGlobalIdx: -1,
      markRejectionHandledFuncIdx: -1,
      finallyRestoreCapsTypeIdx: -1,
      finallyRestoreSettleFuncIdx: -1,
      finallyRestoreRejectFuncIdx: -1,
      finallyAfterFuncIdx: -1,
      timerFuncArrTypeIdx: -1,
      timerI64ArrTypeIdx: -1,
      timerI32ArrTypeIdx: -1,
      timerCountGlobalIdx: -1,
      timerCapGlobalIdx: -1,
      timerDeadlinesGlobalIdx: -1,
      timerCallbacksGlobalIdx: -1,
      timerCapturesGlobalIdx: -1,
      timerIntervalsGlobalIdx: -1,
      timerCancelledGlobalIdx: -1,
      timerAddFuncIdx: -1,
      timerCancelFuncIdx: -1,
      timerPeekDeadlineFuncIdx: -1,
      timerFireDueFuncIdx: -1,
      runLoopFuncIdx: -1,
      runLoopNowFuncIdx: -1,
      timerHeapRegistered: false,
      stdinReactor: false,
      stdinNonblockSetGlobalIdx: -1,
      stdinFdActiveGlobalIdx: -1,
      stdinBufLenGlobalIdx: -1,
      stdinBufPosGlobalIdx: -1,
      stdinDrainFuncIdx: -1,
      pollFd0OrClockFuncIdx: -1,
      stdinReaderHookGlobalIdx: -1,
      stdinReaderCapGlobalIdx: -1,
    };
  }
  return ctx.asyncScheduler;
}

/**
 * Type cast for ctx augmentation. Phase 1A doesn't modify
 * `CodegenContext`; instead it stashes per-module state under
 * `ctx.asyncScheduler` (any-typed). Phase 1C+ promotes this to a
 * proper field if the integration matures.
 */
export type CodegenContextWithScheduler = CodegenContext & { asyncScheduler?: AsyncSchedulerState };

/**
 * #1326 — Get or register the `$Promise` WasmGC struct type. The struct
 * has three fields:
 *   - state: i32 (0=pending, 1=fulfilled, 2=rejected)
 *   - value: externref (fulfilled value or rejection reason)
 *   - callbacks: externref (nullable `$PromiseCallback` linked list for
 *     pending `.then` continuations)
 *
 * Returns the registered struct's typeIdx, cached for re-use.
 */
export function getOrRegisterPromiseType(ctx: CodegenContext): number {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.promiseTypeIdx !== -1) return state.promiseTypeIdx;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$Promise",
    fields: [
      { name: "state", type: { kind: "i32" }, mutable: true },
      { name: "value", type: { kind: "externref" }, mutable: true },
      { name: "callbacks", type: { kind: "externref" }, mutable: true },
    ],
  });
  // Mirror the bookkeeping that other struct registrations do so the
  // verifier/walker can find $Promise by name.
  ctx.structMap.set("$Promise", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "$Promise");
  ctx.structFields.set("$Promise", [
    { name: "state", type: { kind: "i32" as const }, mutable: true },
    { name: "value", type: { kind: "externref" as const }, mutable: true },
    { name: "callbacks", type: { kind: "externref" as const }, mutable: true },
  ]);
  state.promiseTypeIdx = typeIdx;
  return typeIdx;
}

/**
 * #1326 — Get or register the microtask-queue arg-vec type. Phase 1A
 * registered the WasmGC array type; Phase 1C-A re-uses it for both the
 * captures buffer and the args buffer (both are externref arrays).
 */
export function getOrRegisterMicrotaskQueueType(ctx: CodegenContext): number {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.microtaskArgsArrTypeIdx !== -1) return state.microtaskArgsArrTypeIdx;
  const arrTypeIdx = getOrRegisterArrayType(ctx, "externref", { kind: "externref" });
  state.microtaskArgsArrTypeIdx = arrTypeIdx;
  return arrTypeIdx;
}

function getOrRegisterPromiseCallbackType(ctx: CodegenContext): number {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.promiseCallbackTypeIdx !== -1) return state.promiseCallbackTypeIdx;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$PromiseCallback",
    fields: [
      { name: "onFulfilledFn", type: { kind: "funcref" }, mutable: false },
      { name: "onFulfilledCaps", type: { kind: "externref" }, mutable: false },
      { name: "onRejectedFn", type: { kind: "funcref" }, mutable: false },
      { name: "onRejectedCaps", type: { kind: "externref" }, mutable: false },
      { name: "next", type: { kind: "externref" }, mutable: false },
    ],
  });
  state.promiseCallbackTypeIdx = typeIdx;
  return typeIdx;
}

function getOrRegisterThenCapsType(ctx: CodegenContext): number {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.thenCapsTypeIdx !== -1) return state.thenCapsTypeIdx;
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__then_caps",
    fields: [
      { name: "callback", type: { kind: "externref" }, mutable: false },
      { name: "chained", type: { kind: "ref", typeIdx: promiseTypeIdx }, mutable: false },
    ],
  });
  state.thenCapsTypeIdx = typeIdx;
  return typeIdx;
}

/**
 * #1326 Phase 1C-A — Idempotently register the microtask queue (types,
 * globals, helper functions). Safe to call from anywhere in the codegen
 * pipeline, but callers must keep in mind that the new function indices
 * land at the END of the current `ctx.mod.functions` array — registering
 * mid-function-body emit shifts subsequent funcIdx values, so callers in
 * Phase 1C-B should invoke this BEFORE any function bodies that reference
 * the registered indices.
 */
export function ensureMicrotaskQueue(ctx: CodegenContext): void {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.enqueueFuncIdx !== -1) return; // already registered

  // 1. Type registration.
  //    Args/captures arrays share `__arr_externref` (already registered for
  //    most async modules). Funcref array gets its own typeIdx.
  const argsArrIdx = getOrRegisterMicrotaskQueueType(ctx);
  state.microtaskArgsArrTypeIdx = argsArrIdx;

  // Register $__arr_mt_func (array of funcref). We can't reuse
  // getOrRegisterArrayType because the arrayTypeMap key is the elem kind
  // string and funcref shares its key space with externref structures.
  const funcArrIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "__arr_mt_func",
    element: { kind: "funcref" } as ValType,
    mutable: true,
  } as unknown as import("../ir/types.js").ArrayTypeDef);
  state.microtaskFuncArrTypeIdx = funcArrIdx;

  // Register the wrapper function type. Every queued callback has the
  // uniform shape `(captures externref, value externref) → externref`.
  // The result is dropped at drain time — Phase 1C-B wrappers stash the
  // result onto the chained promise's `value` field internally.
  state.microtaskFuncTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$__mt_func_type",
  );

  // 2. Global registration. Six globals total: three i32 indices (head,
  //    tail, cap) and three ref-null arrays (funcs, caps, args).
  const baseGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  state.microtaskHeadGlobalIdx = baseGlobalIdx;
  ctx.mod.globals.push({
    name: "__mt_head",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  state.microtaskTailGlobalIdx = baseGlobalIdx + 1;
  ctx.mod.globals.push({
    name: "__mt_tail",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  state.microtaskCapGlobalIdx = baseGlobalIdx + 2;
  ctx.mod.globals.push({
    name: "__mt_cap",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });

  // Array-valued globals init to `ref.null` of the matching type so we can
  // detect "first use" inside enqueue and lazily allocate the storage.
  state.microtaskFuncsGlobalIdx = baseGlobalIdx + 3;
  ctx.mod.globals.push({
    name: "__mt_funcs",
    type: { kind: "ref_null", typeIdx: funcArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: funcArrIdx }],
  });
  state.microtaskCapsGlobalIdx = baseGlobalIdx + 4;
  ctx.mod.globals.push({
    name: "__mt_caps",
    type: { kind: "ref_null", typeIdx: argsArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: argsArrIdx }],
  });
  state.microtaskArgsGlobalIdx = baseGlobalIdx + 5;
  ctx.mod.globals.push({
    name: "__mt_args",
    type: { kind: "ref_null", typeIdx: argsArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: argsArrIdx }],
  });

  // 3. Helper function bodies. Index assignment matches push order — keep
  //    the order grow → enqueue → drain so each later body can reference
  //    the prior ones.
  state.growFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, state.growFuncIdx, {
    name: "__microtask_grow",
    typeIdx: addFuncType(ctx, [{ kind: "i32" }], [], "$__mt_grow_type"),
    locals: buildGrowLocals(funcArrIdx, argsArrIdx),
    body: buildGrowBody(state, funcArrIdx, argsArrIdx),
    exported: false,
  });
  ctx.funcMap.set("__microtask_grow", state.growFuncIdx);

  state.enqueueFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, state.enqueueFuncIdx, {
    name: "__microtask_enqueue",
    typeIdx: addFuncType(
      ctx,
      [{ kind: "funcref" } as ValType, { kind: "externref" }, { kind: "externref" }],
      [],
      "$__mt_enqueue_type",
    ),
    locals: [],
    body: buildEnqueueBody(state, funcArrIdx, argsArrIdx),
    exported: false,
  });
  ctx.funcMap.set("__microtask_enqueue", state.enqueueFuncIdx);

  state.drainFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, state.drainFuncIdx, {
    name: "__drain_microtasks",
    typeIdx: addFuncType(ctx, [], [], "$__mt_drain_type"),
    locals: buildDrainLocals(),
    body: buildDrainBody(state, funcArrIdx, argsArrIdx),
    exported: false,
  });
  ctx.funcMap.set("__drain_microtasks", state.drainFuncIdx);
}

function buildGrowLocals(funcArrIdx: number, argsArrIdx: number): import("../ir/types.js").LocalDef[] {
  // Param 0: $newCap (i32). Local slots start at 1.
  return [
    { name: "$oldFuncs", type: { kind: "ref_null", typeIdx: funcArrIdx } },
    { name: "$oldCaps", type: { kind: "ref_null", typeIdx: argsArrIdx } },
    { name: "$oldArgs", type: { kind: "ref_null", typeIdx: argsArrIdx } },
    { name: "$oldHead", type: { kind: "i32" } },
    { name: "$oldTail", type: { kind: "i32" } },
    { name: "$i", type: { kind: "i32" } },
    { name: "$dst", type: { kind: "i32" } },
  ];
}

function buildGrowBody(state: AsyncSchedulerState, funcArrIdx: number, argsArrIdx: number): Instr[] {
  const newCapLocal = 0;
  const oldFuncs = 1;
  const oldCaps = 2;
  const oldArgs = 3;
  const oldHead = 4;
  const oldTail = 5;
  const i = 6;
  const dst = 7;

  return [
    // Snapshot the old state.
    { op: "global.get", index: state.microtaskFuncsGlobalIdx },
    { op: "local.set", index: oldFuncs },
    { op: "global.get", index: state.microtaskCapsGlobalIdx },
    { op: "local.set", index: oldCaps },
    { op: "global.get", index: state.microtaskArgsGlobalIdx },
    { op: "local.set", index: oldArgs },
    { op: "global.get", index: state.microtaskHeadGlobalIdx },
    { op: "local.set", index: oldHead },
    { op: "global.get", index: state.microtaskTailGlobalIdx },
    { op: "local.set", index: oldTail },

    // Allocate the new arrays with init = ref.null.
    // funcs: array.new (default=null funcref) of $newCap.
    { op: "ref.null.func" },
    { op: "local.get", index: newCapLocal },
    { op: "array.new", typeIdx: funcArrIdx },
    { op: "global.set", index: state.microtaskFuncsGlobalIdx },

    { op: "ref.null.extern" },
    { op: "local.get", index: newCapLocal },
    { op: "array.new", typeIdx: argsArrIdx },
    { op: "global.set", index: state.microtaskCapsGlobalIdx },

    { op: "ref.null.extern" },
    { op: "local.get", index: newCapLocal },
    { op: "array.new", typeIdx: argsArrIdx },
    { op: "global.set", index: state.microtaskArgsGlobalIdx },

    // If oldFuncs is null, no live entries to copy. Just reset head/tail
    // pointers and capacity, then return.
    { op: "local.get", index: oldFuncs },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "i32.const", value: 0 },
        { op: "global.set", index: state.microtaskHeadGlobalIdx },
        { op: "i32.const", value: 0 },
        { op: "global.set", index: state.microtaskTailGlobalIdx },
        { op: "local.get", index: newCapLocal },
        { op: "global.set", index: state.microtaskCapGlobalIdx },
        { op: "return" },
      ],
    },

    // Copy live slice [oldHead, oldTail) into the new arrays starting at 0.
    { op: "local.get", index: oldHead },
    { op: "local.set", index: i },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: dst },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: i },
            { op: "local.get", index: oldTail },
            { op: "i32.eq" },
            // depth 1: exit the enclosing block (skip the loop label).
            { op: "br_if", depth: 1 },

            // funcs[dst] = oldFuncs[i]
            { op: "global.get", index: state.microtaskFuncsGlobalIdx },
            { op: "local.get", index: dst },
            { op: "local.get", index: oldFuncs },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: funcArrIdx },
            { op: "array.set", typeIdx: funcArrIdx },

            // caps[dst] = oldCaps[i]
            { op: "global.get", index: state.microtaskCapsGlobalIdx },
            { op: "local.get", index: dst },
            { op: "local.get", index: oldCaps },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: argsArrIdx },
            { op: "array.set", typeIdx: argsArrIdx },

            // args[dst] = oldArgs[i]
            { op: "global.get", index: state.microtaskArgsGlobalIdx },
            { op: "local.get", index: dst },
            { op: "local.get", index: oldArgs },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: argsArrIdx },
            { op: "array.set", typeIdx: argsArrIdx },

            // i++, dst++
            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "local.get", index: dst },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: dst },
            // depth 0: re-enter the loop label.
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // Finalise head/tail/cap.
    { op: "i32.const", value: 0 },
    { op: "global.set", index: state.microtaskHeadGlobalIdx },
    { op: "local.get", index: dst },
    { op: "global.set", index: state.microtaskTailGlobalIdx },
    { op: "local.get", index: newCapLocal },
    { op: "global.set", index: state.microtaskCapGlobalIdx },
  ];
}

function buildEnqueueBody(state: AsyncSchedulerState, funcArrIdx: number, argsArrIdx: number): Instr[] {
  const fnLocal = 0;
  const capsLocal = 1;
  const argLocal = 2;

  return [
    // Lazy first-allocate. Test `funcs` against null.
    { op: "global.get", index: state.microtaskFuncsGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "i32.const", value: MICROTASK_QUEUE_INITIAL_SLOTS },
        { op: "call", funcIdx: state.growFuncIdx },
      ],
    },

    // If tail == cap, double the queue.
    { op: "global.get", index: state.microtaskTailGlobalIdx },
    { op: "global.get", index: state.microtaskCapGlobalIdx },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "global.get", index: state.microtaskCapGlobalIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.shl" },
        { op: "call", funcIdx: state.growFuncIdx },
      ],
    },

    // Store fn, caps, arg at index `tail`.
    { op: "global.get", index: state.microtaskFuncsGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "global.get", index: state.microtaskTailGlobalIdx },
    { op: "local.get", index: fnLocal },
    { op: "array.set", typeIdx: funcArrIdx },

    { op: "global.get", index: state.microtaskCapsGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "global.get", index: state.microtaskTailGlobalIdx },
    { op: "local.get", index: capsLocal },
    { op: "array.set", typeIdx: argsArrIdx },

    { op: "global.get", index: state.microtaskArgsGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "global.get", index: state.microtaskTailGlobalIdx },
    { op: "local.get", index: argLocal },
    { op: "array.set", typeIdx: argsArrIdx },

    // tail++
    { op: "global.get", index: state.microtaskTailGlobalIdx },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "global.set", index: state.microtaskTailGlobalIdx },
  ];
}

function buildDrainLocals(): import("../ir/types.js").LocalDef[] {
  return [
    { name: "$fn", type: { kind: "funcref" } as ValType },
    { name: "$caps", type: { kind: "externref" } },
    { name: "$arg", type: { kind: "externref" } },
  ];
}

function buildDrainBody(state: AsyncSchedulerState, funcArrIdx: number, argsArrIdx: number): Instr[] {
  const fnLocal = 0;
  const capsLocal = 1;
  const argLocal = 2;

  return [
    // If the queue was never used (`funcs` global null), there's nothing
    // to drain. Early-return to avoid `ref.as_non_null` on a null ref.
    { op: "global.get", index: state.microtaskFuncsGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [{ op: "return" }],
    },

    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // Done when head == tail.
            { op: "global.get", index: state.microtaskHeadGlobalIdx },
            { op: "global.get", index: state.microtaskTailGlobalIdx },
            { op: "i32.eq" },
            // depth 1: exit the enclosing block (skip the loop label).
            { op: "br_if", depth: 1 },

            // Read fn, caps, arg at head.
            { op: "global.get", index: state.microtaskFuncsGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "global.get", index: state.microtaskHeadGlobalIdx },
            { op: "array.get", typeIdx: funcArrIdx },
            { op: "local.set", index: fnLocal },

            { op: "global.get", index: state.microtaskCapsGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "global.get", index: state.microtaskHeadGlobalIdx },
            { op: "array.get", typeIdx: argsArrIdx },
            { op: "local.set", index: capsLocal },

            { op: "global.get", index: state.microtaskArgsGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "global.get", index: state.microtaskHeadGlobalIdx },
            { op: "array.get", typeIdx: argsArrIdx },
            { op: "local.set", index: argLocal },

            // head++ (advance BEFORE the call so a callback that enqueues
            // more entries doesn't have to worry about an unconsumed slot).
            { op: "global.get", index: state.microtaskHeadGlobalIdx },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "global.set", index: state.microtaskHeadGlobalIdx },

            // call_ref fn(caps, arg) — push args then the funcref, then
            // ref.cast to a non-null `(ref $__mt_func_type)` because
            // call_ref requires a typed non-null funcref.
            { op: "local.get", index: capsLocal },
            { op: "local.get", index: argLocal },
            { op: "local.get", index: fnLocal },
            { op: "ref.cast", typeIdx: state.microtaskFuncTypeIdx },
            { op: "call_ref", typeIdx: state.microtaskFuncTypeIdx },
            { op: "drop" },

            // depth 0: re-enter the loop label.
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

export function ensurePromiseSettleFunctions(ctx: CodegenContext): void {
  ensureMicrotaskQueue(ctx);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.promiseFulfillFuncIdx !== -1) return;

  // (#2958) Register the unhandled-rejection tracking substrate (node struct,
  // list-head global, mark-handled helper) BEFORE `buildPromiseSettleBody`
  // reads `state.unhandledHeadGlobalIdx` — a no-op unless `ctx.wasi` (the native
  // `$Promise` carrier is wasi-gated; host mode never reaches here).
  ensureUnhandledRejectionTracking(ctx);

  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const callbackTypeIdx = getOrRegisterPromiseCallbackType(ctx);
  const capsTypeIdx = getOrRegisterThenCapsType(ctx);
  const settleTypeIdx = addFuncType(
    ctx,
    [{ kind: "ref", typeIdx: promiseTypeIdx }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$__promise_settle_type",
  );

  state.promiseFulfillFuncIdx = mintDefinedFunc(ctx);
  state.promiseRejectFuncIdx = mintDefinedFunc(ctx);
  state.identityFulfillWrapperFuncIdx = mintDefinedFunc(ctx);
  state.identityRejectWrapperFuncIdx = mintDefinedFunc(ctx);
  // (#2867 Gap 1) reserve the resolve-value slot up-front so the identity
  // fulfill wrapper below (and the `.then` handler wrappers) can reference it
  // before its body is pushed — late assignment would shift later funcIdxs.
  state.promiseResolveValueFuncIdx = mintDefinedFunc(ctx);
  // (#3125) Register the resolve-value NAME up-front too, so the thenable
  // substrate below (whose `ensurePromiseExecutorClosures` looks the settle
  // helpers up by name) sees it before the body is pushed.
  ctx.funcMap.set("__promise_resolve_value", state.promiseResolveValueFuncIdx);

  pushDefinedFunc(ctx, state.promiseFulfillFuncIdx, {
    name: "__promise_fulfill",
    typeIdx: settleTypeIdx,
    locals: buildPromiseSettleLocals(callbackTypeIdx),
    body: buildPromiseSettleBody(state, promiseTypeIdx, callbackTypeIdx, PROMISE_STATE_FULFILLED),
    exported: false,
  });
  ctx.funcMap.set("__promise_fulfill", state.promiseFulfillFuncIdx);

  pushDefinedFunc(ctx, state.promiseRejectFuncIdx, {
    name: "__promise_reject",
    typeIdx: settleTypeIdx,
    locals: buildPromiseSettleLocals(callbackTypeIdx),
    body: buildPromiseSettleBody(state, promiseTypeIdx, callbackTypeIdx, PROMISE_STATE_REJECTED),
    exported: false,
  });
  ctx.funcMap.set("__promise_reject", state.promiseRejectFuncIdx);

  // The identity FULFILL wrapper settles its chained promise via
  // resolve-value (not fulfill) so a passed-through value that is itself a
  // `$Promise` is adopted, AND so the adoption reactions this resolve-value
  // helper registers on a pending inner promise recurse correctly (#2867 Gap 1).
  // The identity REJECT wrapper stays a direct reject — rejection reasons are
  // never assimilated.
  pushDefinedFunc(ctx, state.identityFulfillWrapperFuncIdx, {
    name: "__then_identity_fulfill",
    typeIdx: state.microtaskFuncTypeIdx,
    locals: buildIdentityWrapperLocals(capsTypeIdx),
    body: buildIdentityWrapperBody(capsTypeIdx, state.promiseResolveValueFuncIdx),
    exported: false,
  });
  ctx.funcMap.set("__then_identity_fulfill", state.identityFulfillWrapperFuncIdx);

  pushDefinedFunc(ctx, state.identityRejectWrapperFuncIdx, {
    name: "__then_identity_reject",
    typeIdx: state.microtaskFuncTypeIdx,
    locals: buildIdentityWrapperLocals(capsTypeIdx),
    body: buildIdentityWrapperBody(capsTypeIdx, state.promiseRejectFuncIdx),
    exported: false,
  });
  ctx.funcMap.set("__then_identity_reject", state.identityRejectWrapperFuncIdx);

  // (#3125) Thenable-assimilation substrate — MUST be ensured BEFORE the
  // resolve-value body below is built, because that body bakes the substrate's
  // funcIdxs (`__promise_has_callable_then`, `__promise_thenable_job`). Null
  // only in a non-standalone/wasi context (defensive; the native promise
  // machinery is standalone/wasi-gated at every call site).
  const thenable = ensurePromiseThenableSubstrate(ctx, state);

  pushDefinedFunc(ctx, state.promiseResolveValueFuncIdx, {
    name: "__promise_resolve_value",
    typeIdx: settleTypeIdx,
    locals: buildPromiseResolveValueLocals(promiseTypeIdx),
    body: buildPromiseResolveValueBody(ctx, state, promiseTypeIdx, callbackTypeIdx, capsTypeIdx, thenable),
    exported: false,
  });
  ctx.funcMap.set("__promise_resolve_value", state.promiseResolveValueFuncIdx);
}

/**
 * (#2959, moved here for #3125) Per-module cache of the two synthesised
 * settle-closure funcs + the capturing wrapper struct type. Minted once and
 * reused for every `new Promise` in the module AND for every
 * PromiseResolveThenableJob (#3125), so the module carries a single
 * `__promise_resolve_cl` / `__promise_reject_cl` pair regardless of
 * executor/thenable count.
 *
 * Previously private to promise-executor.ts; it lives here because the #3125
 * thenable job (built inside `ensurePromiseSettleFunctions`) needs the same
 * settle closures, and promise-executor.ts already imports from this module
 * (the reverse import would be an eval-time cycle).
 */
export interface PromiseExecutorClosures {
  /** `__promise_resolve_cl` funcIdx — settles the captured promise via resolve-value (assimilating). */
  resolveClFuncIdx: number;
  /** `__promise_reject_cl` funcIdx — settles the captured promise via reject. */
  rejectClFuncIdx: number;
  /** The `$__promise_settle_cap` struct typeIdx (subtype of the canonical `(externref)->()` wrapper). */
  capTypeIdx: number;
  /** `$Promise` struct typeIdx. */
  promiseTypeIdx: number;
  /** `__promise_reject(promise, reason) -> reason` funcIdx (used by the executor-throw catch). */
  rejectFuncIdx: number;
}

/**
 * Idempotently mint the two capturing settle-closure trampolines and register
 * the `$__promise_settle_cap` wrapper subtype. Cached on the context.
 *
 * `$__promise_settle_cap` is a struct subtype of the canonical `(externref)->()`
 * func-ref wrapper (`getOrCreateFuncRefWrapperTypes(ctx,[externref],[])`), so a
 * value of this type passes an executor's / user thenable's `resolve(x)` call
 * site `ref.test (ref $wrap)` and dispatches natively. It inherits field 0
 * (`func: funcref`) and adds field 1 (`cap_promise: (ref $Promise)`).
 *
 * Each trampoline has exactly the canonical lifted func type
 * (`(ref $wrapperRoot, externref) -> ()`) so the call site's typed-funcref cast
 * and `call_ref` succeed; the body downcasts root self to the `cap` subtype to
 * recover the promise.
 */
export function ensurePromiseExecutorClosures(ctx: CodegenContext): PromiseExecutorClosures | null {
  const cache = ctx as unknown as { __promiseExecutorClosures?: PromiseExecutorClosures };
  if (cache.__promiseExecutorClosures) return cache.__promiseExecutorClosures;

  ensurePromiseSettleFunctions(ctx);
  const resolveValueFuncIdx = ctx.funcMap.get("__promise_resolve_value");
  const rejectFuncIdx = ctx.funcMap.get("__promise_reject");
  if (resolveValueFuncIdx === undefined || rejectFuncIdx === undefined) return null;

  const promiseTypeIdx = getOrRegisterPromiseType(ctx);

  // Canonical `(externref) -> ()` wrapper — the SAME struct a compiled
  // `resolve(x)` call site ref.tests / ref.casts against (shared via the
  // signature cache). Our cap struct subtypes it so the native dispatch matches.
  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, [{ kind: "externref" }], []);
  if (!wrapper) return null;

  const capTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__promise_settle_cap",
    fields: [
      // Field 0 is inherited from the wrapper root (funcref); it MUST be
      // redeclared identically in the subtype — as must the #3673 $arity slot.
      { name: "func", type: { kind: "funcref" }, mutable: false },
      closureArityField(),
      closureBagField(),
      { name: "cap_promise", type: { kind: "ref", typeIdx: promiseTypeIdx }, mutable: false },
    ],
    superTypeIdx: wrapper.structTypeIdx,
  });

  // Mint both trampolines UP-FRONT (stable-regime handles) before any code
  // references them, mirroring ensurePromiseSettleFunctions' discipline.
  const resolveClFuncIdx = mintDefinedFunc(ctx);
  const rejectClFuncIdx = mintDefinedFunc(ctx);

  // Body: recover captured promise from self (downcast to the cap subtype),
  // then settle it with the incoming value. resolve routes through
  // __promise_resolve_value (assimilation: resolve(aPromise) chains); reject
  // routes through __promise_reject. The already-settled guard lives in the
  // settle helpers (buildPromiseSettleBody), so double-settle / settle-after-
  // throw is a spec-correct no-op by construction.
  const makeBody = (settleFuncIdx: number): Instr[] => [
    { op: "local.get", index: 0 }, // self: (ref $wrapperRoot)
    { op: "ref.cast", typeIdx: capTypeIdx }, // downcast to the cap subtype (non-null)
    { op: "struct.get", typeIdx: capTypeIdx, fieldIdx: CLOSURE_CAPTURE_FIELD_BASE }, // captured (ref $Promise)
    { op: "local.get", index: 1 }, // value: externref
    { op: "call", funcIdx: settleFuncIdx }, // settle -> externref
    { op: "drop" }, // trampoline result type is () — discard the settled value
  ];

  pushDefinedFunc(ctx, resolveClFuncIdx, {
    name: "__promise_resolve_cl",
    typeIdx: wrapper.liftedFuncTypeIdx,
    locals: [],
    body: makeBody(resolveValueFuncIdx),
    exported: false,
  });
  ctx.funcMap.set("__promise_resolve_cl", resolveClFuncIdx);

  pushDefinedFunc(ctx, rejectClFuncIdx, {
    name: "__promise_reject_cl",
    typeIdx: wrapper.liftedFuncTypeIdx,
    locals: [],
    body: makeBody(rejectFuncIdx),
    exported: false,
  });
  ctx.funcMap.set("__promise_reject_cl", rejectClFuncIdx);

  const result: PromiseExecutorClosures = {
    resolveClFuncIdx,
    rejectClFuncIdx,
    capTypeIdx,
    promiseTypeIdx,
    rejectFuncIdx,
  };
  cache.__promiseExecutorClosures = result;
  return result;
}

/**
 * (#3125) §27.2.1.3.2 Promise Resolve Functions — the thenable-assimilation
 * substrate for the native `$Promise` carrier. Registered once per module by
 * `ensurePromiseSettleFunctions`, standalone/wasi only:
 *
 *   - `__promise_has_callable_then(value) -> i32` — steps 8–11's Get("then") +
 *     IsCallable, as a RESERVED driver filled at finalize by
 *     `fillPromiseThenableHelpers` (closed-method-dispatch.ts), after every
 *     object-literal struct + closure shape is registered. The `$Object` arm's
 *     `__extern_get` RUNS accessors, so a poisoned `then` getter throws out of
 *     the predicate — the caller (resolve-value) catches and rejects (step 9).
 *   - `__promise_thenable_job(caps, thenable)` — the PromiseResolveThenableJob:
 *     materialises resolve/reject as the SAME `$__promise_settle_cap` capturing
 *     closures the native executor uses (#2959), then invokes
 *     `__call_m_then_vararg(thenable, [resolveFn, rejectFn])` — the #2151/#3117
 *     dispatcher that covers closed-struct `then` methods of any declared
 *     arity, closure-valued `then` fields, and open `$Object` receivers, with
 *     `this` = the thenable. A throw before settle rejects the promise
 *     (step 15; the one-shot settle guard makes post-settle throws no-ops).
 *   - a pooled self-resolution TypeError (step 6) message + in-module
 *     `__new_TypeError` constructor.
 *
 * Returns the baked indices for `buildPromiseResolveValueBody`, or null when
 * not applicable (host/gc — never reached in practice: the settle helpers are
 * only ensured by standalone/wasi-gated emitters).
 */
interface PromiseThenableSubstrate {
  hasCallableThenFuncIdx: number;
  thenableJobFuncIdx: number;
  /**
   * `__promise_peel_value(value) -> externref` — unwraps a `$AnyValue`-boxed
   * resolution (tag 6 → raw GC object; tag 5 → the extern payload) so the
   * `$Promise`/thenable classification sees the RAW object. An `any`-typed
   * resolution (`const o: any = …; Promise.resolve(o)`) arrives as an
   * externref-wrapped `$AnyValue` box, which would MISS every `ref.test`
   * arm (the poisoned-then getter never ran without this). Placeholder is
   * IDENTITY (filled at finalize alongside the predicate); non-box values
   * pass through unchanged, and the ORIGINAL (boxed) value is still what
   * fulfils/rejects — the peel is classification/dispatch-only, so value
   * identity across the promise is preserved.
   */
  peelValueFuncIdx: number;
  newTypeErrorFuncIdx: number;
  selfResolutionMsg: string;
}

const SELF_RESOLUTION_MSG = "Chaining cycle detected for promise";

function ensurePromiseThenableSubstrate(
  ctx: CodegenContext,
  state: AsyncSchedulerState,
): PromiseThenableSubstrate | null {
  if (ctx.standalone !== true && ctx.wasi !== true) return null;
  const cache = ctx as unknown as { __promiseThenableSubstrate?: PromiseThenableSubstrate | null };
  if (cache.__promiseThenableSubstrate !== undefined) return cache.__promiseThenableSubstrate;

  // Step-6 TypeError machinery: in-module constructor (no host in wasi/
  // standalone) + pooled message + the exception tag for the job's try/catch.
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  addStringConstantGlobal(ctx, SELF_RESOLUTION_MSG);
  const newTypeErrorFuncIdx = ctx.funcMap.get("__new_TypeError");
  const exnTag = ensureExnTag(ctx);

  // The dispatcher the job calls. Reserving it NOW (compile phase) registers
  // all its fallback-arm deps (object runtime, "then" string constant,
  // `__apply_closure`) so the finalize fills only READ funcMap (#1719).
  const varargThenFuncIdx = reserveClosedMethodDispatchVararg(ctx, "then");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");

  // resolve/reject closure VALUES for the job — the executor's settle caps.
  const execClosures = ensurePromiseExecutorClosures(ctx);

  if (
    newTypeErrorFuncIdx === undefined ||
    objVecNewIdx === undefined ||
    objVecPushIdx === undefined ||
    execClosures === null
  ) {
    cache.__promiseThenableSubstrate = null;
    return null;
  }

  // __promise_has_callable_then(value: externref) -> i32 — reserved; filled at
  // finalize. The `i32.const 0` placeholder is VALID and semantically safe: if
  // the fill is ever skipped, every value classifies non-thenable and the
  // resolve path degrades to the pre-#3125 direct-fulfil behaviour.
  const hasThenTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__promise_has_then_type");
  const hasCallableThenFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, hasCallableThenFuncIdx, {
    name: "__promise_has_callable_then",
    typeIdx: hasThenTypeIdx,
    locals: [],
    body: [{ op: "i32.const", value: 0 }],
    exported: false,
  });
  ctx.funcMap.set("__promise_has_callable_then", hasCallableThenFuncIdx);

  // __promise_peel_value(value: externref) -> externref — reserved; filled at
  // finalize (needs `$AnyValue`, whose typeIdx may not exist yet). IDENTITY
  // placeholder: raw (unboxed) values are classified/dispatched unchanged.
  const peelTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$__promise_peel_type");
  const peelValueFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, peelValueFuncIdx, {
    name: "__promise_peel_value",
    typeIdx: peelTypeIdx,
    locals: [],
    body: [{ op: "local.get", index: 0 }],
    exported: false,
  });
  ctx.funcMap.set("__promise_peel_value", peelValueFuncIdx);
  ctx.promiseThenableReserved = true;

  // __promise_thenable_job(capsRaw: externref, thenable: externref) -> externref
  // Uniform microtask signature. caps = $__then_caps{callback: null, chained:
  // promise}; the thenable rides the value slot.
  const capsTypeIdx = getOrRegisterThenCapsType(ctx);
  const promiseLocal = 2;
  const reasonLocal = 3;
  const vecLocal = 4;
  const jobLocals: LocalDef[] = [
    { name: "$promise", type: { kind: "ref_null", typeIdx: state.promiseTypeIdx } },
    { name: "$reason", type: { kind: "externref" } },
    { name: "$argvec", type: { kind: "externref" } },
  ];
  const emitSettleCap = (clFuncIdx: number): Instr[] => [
    { op: "ref.func", funcIdx: clFuncIdx },
    { op: "i32.const", value: 1 }, // (#3673) $arity — settle callbacks take 1 arg
    closureBagInitInstr(), // (#4241) $bag
    { op: "local.get", index: promiseLocal },
    { op: "ref.as_non_null" },
    { op: "struct.new", typeIdx: execClosures.capTypeIdx },
    { op: "extern.convert_any" },
  ];
  const jobTryBody: Instr[] = [
    // argvec = [resolveFn, rejectFn]
    { op: "call", funcIdx: objVecNewIdx },
    { op: "local.set", index: vecLocal },
    { op: "local.get", index: vecLocal },
    ...emitSettleCap(execClosures.resolveClFuncIdx),
    { op: "call", funcIdx: objVecPushIdx },
    { op: "local.get", index: vecLocal },
    ...emitSettleCap(execClosures.rejectClFuncIdx),
    { op: "call", funcIdx: objVecPushIdx },
    // __call_m_then_vararg(peel(thenable), argvec) — `then.call(thenable,
    // res, rej)`. The peel unwraps an `$AnyValue`-boxed resolution so the
    // dispatcher's `ref.test` arms (closed structs / `$Object`) see the RAW
    // object as the receiver.
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: peelValueFuncIdx },
    { op: "local.get", index: vecLocal },
    { op: "call", funcIdx: varargThenFuncIdx },
    { op: "drop" },
  ];
  const thenableJobFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, thenableJobFuncIdx, {
    name: "__promise_thenable_job",
    typeIdx: state.microtaskFuncTypeIdx,
    locals: jobLocals,
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: capsTypeIdx },
      { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: promiseLocal },
      buildTargetTaggedTry(ctx, { kind: "empty" }, jobTryBody, [
        {
          tagIdx: exnTag,
          body: [
            // A throw from Get/then-call before settle rejects the promise
            // (§27.2.2.2 step 2 / §27.2.1.3.2 step 15). Post-settle throws
            // are no-ops via the one-shot settle guard.
            { op: "local.set", index: reasonLocal },
            { op: "local.get", index: promiseLocal },
            { op: "ref.as_non_null" },
            { op: "local.get", index: reasonLocal },
            { op: "call", funcIdx: state.promiseRejectFuncIdx },
            { op: "drop" },
          ],
        },
      ]),
      { op: "ref.null.extern" },
    ],
    exported: false,
  });
  ctx.funcMap.set("__promise_thenable_job", thenableJobFuncIdx);

  const result: PromiseThenableSubstrate = {
    hasCallableThenFuncIdx,
    thenableJobFuncIdx,
    peelValueFuncIdx,
    newTypeErrorFuncIdx,
    selfResolutionMsg: SELF_RESOLUTION_MSG,
  };
  cache.__promiseThenableSubstrate = result;
  return result;
}

function buildPromiseSettleLocals(callbackTypeIdx: number): LocalDef[] {
  // Params 0/1: (promise, value). Locals start at 2.
  return [
    { name: "$callbacks", type: { kind: "externref" } },
    { name: "$callback", type: { kind: "ref", typeIdx: callbackTypeIdx } },
  ];
}

function buildPromiseSettleBody(
  state: AsyncSchedulerState,
  promiseTypeIdx: number,
  callbackTypeIdx: number,
  settledState: typeof PROMISE_STATE_FULFILLED | typeof PROMISE_STATE_REJECTED,
): Instr[] {
  const promiseLocal = 0;
  const valueLocal = 1;
  const callbacksLocal = 2;
  const callbackLocal = 3;
  const fnFieldIdx = settledState === PROMISE_STATE_FULFILLED ? 0 : 2;
  const capsFieldIdx = settledState === PROMISE_STATE_FULFILLED ? 1 : 3;

  return [
    // Promise settlement is one-shot. If a user callback tries to resolve the
    // same chained promise again, return the attempted value and leave the
    // original state/value intact.
    { op: "local.get", index: promiseLocal },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: valueLocal }, { op: "return" }],
    },

    // promise.state = fulfilled/rejected; promise.value = value
    { op: "local.get", index: promiseLocal },
    { op: "i32.const", value: settledState },
    { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: promiseLocal },
    { op: "local.get", index: valueLocal },
    { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 1 },

    // Detach callbacks before enqueueing so re-entrant `.then` calls append to
    // the settled promise's normal immediate-enqueue path.
    { op: "local.get", index: promiseLocal },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: callbacksLocal },
    { op: "local.get", index: promiseLocal },
    { op: "ref.null.extern" },
    { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 2 },

    // (#2958) A REJECTED settle with NO detached callbacks means no reaction was
    // attached before the promise rejected — record it as (so-far) unhandled so
    // the exit-time reporter can surface it. A later `.then/.catch` marks it
    // handled. Skipped for FULFILLED and when tracking is inactive (non-wasi).
    // The drain loop below is a no-op when callbacks is null, so ordering is safe.
    ...(settledState === PROMISE_STATE_REJECTED && state.unhandledHeadGlobalIdx >= 0
      ? ([
          { op: "local.get", index: callbacksLocal },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: buildNoteUnhandledRejection(state, [{ op: "local.get", index: promiseLocal }]),
          },
        ] satisfies Instr[])
      : []),

    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: callbacksLocal },
            { op: "ref.is_null" },
            { op: "br_if", depth: 1 },

            { op: "local.get", index: callbacksLocal },
            { op: "any.convert_extern" },
            { op: "ref.cast", typeIdx: callbackTypeIdx },
            { op: "local.set", index: callbackLocal },

            { op: "local.get", index: callbackLocal },
            { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: fnFieldIdx },
            { op: "local.get", index: callbackLocal },
            { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: capsFieldIdx },
            { op: "local.get", index: valueLocal },
            { op: "call", funcIdx: state.enqueueFuncIdx },

            { op: "local.get", index: callbackLocal },
            { op: "struct.get", typeIdx: callbackTypeIdx, fieldIdx: 4 },
            { op: "local.set", index: callbacksLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    { op: "local.get", index: valueLocal },
  ];
}

function buildIdentityWrapperLocals(capsTypeIdx: number): LocalDef[] {
  // Params 0/1: (caps, value). Local 2 is the decoded caps struct.
  return [{ name: "$caps", type: { kind: "ref", typeIdx: capsTypeIdx } }];
}

function buildIdentityWrapperBody(capsTypeIdx: number, settleFuncIdx: number): Instr[] {
  const rawCapsLocal = 0;
  const valueLocal = 1;
  const capsLocal = 2;
  return [
    { op: "local.get", index: rawCapsLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: capsTypeIdx },
    { op: "local.set", index: capsLocal },
    { op: "local.get", index: capsLocal },
    { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: settleFuncIdx },
  ];
}

function buildPromiseResolveValueLocals(promiseTypeIdx: number): LocalDef[] {
  // Params 0/1: (promise, value). Locals start at 2.
  return [
    { name: "$inner", type: { kind: "ref", typeIdx: promiseTypeIdx } },
    { name: "$caps", type: { kind: "externref" } },
    // (#3125) thenable-assimilation scratch: Get("then") callability verdict +
    // the caught poisoned-getter reason + the `$AnyValue`-peeled resolution.
    { name: "$hasThen", type: { kind: "i32" } },
    { name: "$reason", type: { kind: "externref" } },
    { name: "$poisoned", type: { kind: "i32" } },
    { name: "$peeled", type: { kind: "externref" } },
  ];
}

/**
 * (#2867 Gap 1) `__promise_resolve_value(promise, value)` — the spec
 * "Resolve(promise, value)" step for the native `$Promise` carrier.
 *
 * If `value` is a native `$Promise`, `promise` ADOPTS that inner promise's
 * eventual state instead of fulfilling with the promise object:
 *   - inner FULFILLED  → enqueue `__then_identity_fulfill(caps, inner.value)`
 *   - inner REJECTED   → enqueue `__then_identity_reject(caps, inner.value)`
 *   - inner PENDING    → prepend a `$PromiseCallback` reaction onto inner.callbacks
 * where `caps` is `$__then_caps{callback: null, chained: promise}`, so the
 * identity wrappers settle `promise` when the inner promise eventually settles.
 * Because `__then_identity_fulfill` itself routes back through this helper, a
 * chain of promises-returning-promises is assimilated recursively.
 *
 * If `value` is not a `$Promise`, it checks for a user THENABLE first (#3125,
 * §27.2.1.3.2 steps 6–14): a self-resolution rejects with a TypeError, an
 * object with a callable `then` enqueues a PromiseResolveThenableJob, a
 * poisoned `then` getter rejects with the thrown value, and everything else
 * fulfils directly — byte-behaviour identical to the previous unconditional
 * `__promise_fulfill` for non-thenables.
 */
function buildPromiseResolveValueBody(
  ctx: CodegenContext,
  state: AsyncSchedulerState,
  promiseTypeIdx: number,
  callbackTypeIdx: number,
  capsTypeIdx: number,
  thenable: PromiseThenableSubstrate | null,
): Instr[] {
  // The substrate ensured the exn tag (ensureExnTag) before this body builds.
  const exnTagIdx = ctx.exnTagIdx;
  const promiseLocal = 0;
  const valueLocal = 1;
  const innerLocal = 2;
  const capsLocal = 3;
  const hasThenLocal = 4;
  const reasonLocal = 5;
  const poisonedLocal = 6;

  // (#3125) The non-$Promise arm: thenable check + job enqueue, or direct
  // fulfil. Falls back to the pre-#3125 direct fulfil when the substrate is
  // unavailable (defensive — host/gc never emits this helper).
  const nonPromiseArm: Instr[] =
    thenable === null
      ? [
          // not a promise: fulfil directly
          { op: "local.get", index: promiseLocal },
          { op: "local.get", index: valueLocal },
          { op: "call", funcIdx: state.promiseFulfillFuncIdx },
        ]
      : [
          // hasThen = __promise_has_callable_then(value) — the Get("then") runs
          // accessors, so a poisoned getter THROWS here (§27.2.1.3.2 step 9):
          // catch → reject(promise, thrown).
          buildTargetTaggedTry(
            ctx,
            { kind: "empty" },
            [
              { op: "local.get", index: valueLocal },
              { op: "call", funcIdx: thenable.hasCallableThenFuncIdx },
              { op: "local.set", index: hasThenLocal },
            ],
            [
              {
                tagIdx: exnTagIdx,
                body: [
                  { op: "local.set", index: reasonLocal },
                  { op: "i32.const", value: 1 },
                  { op: "local.set", index: poisonedLocal },
                ],
              },
            ],
          ),
          { op: "local.get", index: poisonedLocal },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              // Get("then") threw: RejectPromise(promise, thrown).
              { op: "local.get", index: promiseLocal },
              { op: "local.get", index: reasonLocal },
              { op: "call", funcIdx: state.promiseRejectFuncIdx },
            ],
            else: [
              { op: "local.get", index: hasThenLocal },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "externref" } },
                then: [
                  // Callable then: enqueue PromiseResolveThenableJob(promise,
                  // value, then). caps = $__then_caps{callback: null, chained:
                  // promise}; the thenable rides the job's value slot (step 14
                  // — the then CALL happens as a job, never inline).
                  { op: "ref.func", funcIdx: thenable.thenableJobFuncIdx },
                  { op: "ref.null.extern" },
                  { op: "local.get", index: promiseLocal },
                  { op: "struct.new", typeIdx: capsTypeIdx },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: valueLocal },
                  { op: "call", funcIdx: state.enqueueFuncIdx },
                  { op: "local.get", index: valueLocal },
                ],
                else: [
                  // Not a thenable: fulfil directly (steps 11 / 16).
                  { op: "local.get", index: promiseLocal },
                  { op: "local.get", index: valueLocal },
                  { op: "call", funcIdx: state.promiseFulfillFuncIdx },
                ],
              },
            ],
          },
        ];

  // (#3125) Step 6 — SameValue(resolution, promise): a promise resolved with
  // ITSELF rejects with a TypeError (resolve-settled-*-self). Emitted inside
  // the $Promise arm (both refs are concrete (ref $Promise), so a plain
  // `ref.eq` is the SameValue). Without the substrate the adopt path is kept
  // unchanged (pre-#3125: self-adoption deadlocks — defensive only).
  const selfCheck: Instr[] =
    thenable === null
      ? []
      : [
          { op: "local.get", index: innerLocal },
          { op: "local.get", index: promiseLocal },
          { op: "ref.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: promiseLocal },
              ...stringConstantExternrefInstrs(ctx, thenable.selfResolutionMsg),
              { op: "call", funcIdx: thenable.newTypeErrorFuncIdx },
              { op: "call", funcIdx: state.promiseRejectFuncIdx },
              { op: "drop" },
              { op: "local.get", index: valueLocal },
              { op: "return" },
            ],
          },
        ];

  // (#3125) Classify the PEELED resolution: an `any`-typed value arrives as an
  // externref-wrapped `$AnyValue` box, which would MISS the `ref.test $Promise`
  // and every thenable arm. The peel is dispatch-only — fulfil/reject still
  // deliver the ORIGINAL `value`, preserving identity across the promise.
  // (Placeholder peel = identity, so pre-fill behaviour is unchanged.)
  const peeledLocal = 7;
  const peelPrelude: Instr[] =
    thenable === null
      ? [
          { op: "local.get", index: valueLocal },
          { op: "local.set", index: peeledLocal },
        ]
      : [
          { op: "local.get", index: valueLocal },
          { op: "call", funcIdx: thenable.peelValueFuncIdx },
          { op: "local.set", index: peeledLocal },
        ];

  return [
    ...peelPrelude,
    { op: "local.get", index: peeledLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        // inner = (ref $Promise) peeled
        { op: "local.get", index: peeledLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: promiseTypeIdx },
        { op: "local.set", index: innerLocal },
        ...selfCheck,
        // caps = $__then_caps{ callback: null, chained: promise }
        { op: "ref.null.extern" },
        { op: "local.get", index: promiseLocal },
        { op: "struct.new", typeIdx: capsTypeIdx },
        { op: "extern.convert_any" },
        { op: "local.set", index: capsLocal },
        // dispatch on inner.state
        { op: "local.get", index: innerLocal },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: PROMISE_STATE_FULFILLED },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // already fulfilled: schedule fulfill reaction with inner.value
            { op: "ref.func", funcIdx: state.identityFulfillWrapperFuncIdx },
            { op: "local.get", index: capsLocal },
            { op: "local.get", index: innerLocal },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
            { op: "call", funcIdx: state.enqueueFuncIdx },
          ],
          else: [
            { op: "local.get", index: innerLocal },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
            { op: "i32.const", value: PROMISE_STATE_REJECTED },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // already rejected: schedule reject reaction with inner.value
                { op: "ref.func", funcIdx: state.identityRejectWrapperFuncIdx },
                { op: "local.get", index: capsLocal },
                { op: "local.get", index: innerLocal },
                { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
                { op: "call", funcIdx: state.enqueueFuncIdx },
              ],
              else: [
                // pending: prepend a reaction node onto inner.callbacks
                { op: "local.get", index: innerLocal },
                { op: "ref.func", funcIdx: state.identityFulfillWrapperFuncIdx },
                { op: "local.get", index: capsLocal },
                { op: "ref.func", funcIdx: state.identityRejectWrapperFuncIdx },
                { op: "local.get", index: capsLocal },
                { op: "local.get", index: innerLocal },
                { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 2 },
                { op: "struct.new", typeIdx: callbackTypeIdx },
                { op: "extern.convert_any" },
                { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 2 },
              ],
            },
          ],
        },
        // result (unused by the microtask drain, but the type must be externref)
        { op: "local.get", index: valueLocal },
      ],
      else: nonPromiseArm,
    },
  ];
}

function ensureUnionHelpersForThenWrapper(ctx: CodegenContext, info: ClosureInfo): void {
  const needsNumberBridge =
    info.paramTypes.some((t) => t.kind === "f64" || t.kind === "i32" || t.kind === "i64") ||
    info.returnType?.kind === "f64" ||
    info.returnType?.kind === "i32" ||
    info.returnType?.kind === "i64";
  if (needsNumberBridge) addUnionImportsViaRegistry(ctx);
}

function pushDefaultForType(body: Instr[], type: ValType): void {
  switch (type.kind) {
    case "i32":
      body.push({ op: "i32.const", value: 0 });
      return;
    case "i64":
      body.push({ op: "i64.const", value: 0n });
      return;
    case "f64":
      body.push({ op: "f64.const", value: 0 });
      return;
    case "externref":
    case "ref_extern":
      body.push({ op: "ref.null.extern" });
      return;
    case "ref":
      body.push({ op: "ref.null", typeIdx: type.typeIdx }, { op: "ref.as_non_null" });
      return;
    case "ref_null":
      body.push({ op: "ref.null", typeIdx: type.typeIdx });
      return;
    case "funcref":
      body.push({ op: "ref.null.func" });
      return;
    default:
      body.push({ op: "ref.null.extern" });
      return;
  }
}

function pushExternrefLocalAsType(ctx: CodegenContext, body: Instr[], valueLocal: number, type: ValType): void {
  body.push({ op: "local.get", index: valueLocal });
  switch (type.kind) {
    case "externref":
    case "ref_extern":
      return;
    case "f64": {
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx !== undefined) {
        body.push({ op: "call", funcIdx: unboxIdx });
      } else {
        body.push({ op: "drop" }, { op: "f64.const", value: 0 });
      }
      return;
    }
    case "i32": {
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx !== undefined) {
        body.push({ op: "call", funcIdx: unboxIdx }, { op: "i32.trunc_sat_f64_s" });
      } else {
        body.push({ op: "ref.is_null" }, { op: "i32.eqz" });
      }
      return;
    }
    case "i64": {
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx !== undefined) {
        body.push({ op: "call", funcIdx: unboxIdx }, { op: "i64.trunc_sat_f64_s" });
      } else {
        body.push({ op: "drop" }, { op: "i64.const", value: 0n });
      }
      return;
    }
    case "ref":
      body.push({ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: type.typeIdx });
      return;
    case "ref_null":
      body.push({ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: type.typeIdx });
      return;
    default:
      body.push({ op: "drop" });
      pushDefaultForType(body, type);
      return;
  }
}

function coerceStackValueToExternref(ctx: CodegenContext, body: Instr[], from: ValType | null): void {
  if (from === null) {
    body.push({ op: "ref.null.extern" });
    return;
  }
  switch (from.kind) {
    case "externref":
    case "ref_extern":
      return;
    case "f64": {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        body.push({ op: "call", funcIdx: boxIdx });
      } else {
        body.push({ op: "drop" }, { op: "ref.null.extern" });
      }
      return;
    }
    case "i32": {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        body.push({ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxIdx });
      } else {
        body.push({ op: "drop" }, { op: "ref.null.extern" });
      }
      return;
    }
    case "i64": {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        body.push({ op: "f64.convert_i64_s" }, { op: "call", funcIdx: boxIdx });
      } else {
        body.push({ op: "drop" }, { op: "ref.null.extern" });
      }
      return;
    }
    case "ref":
    case "ref_null":
      body.push({ op: "extern.convert_any" });
      return;
    default:
      body.push({ op: "drop" }, { op: "ref.null.extern" });
      return;
  }
}

function emitThenWrapperFunction(
  ctx: CodegenContext,
  info: ClosureInfo,
  settleFuncIdx: number,
  namePrefix: string,
): number {
  ensurePromiseSettleFunctions(ctx);
  ensureUnionHelpersForThenWrapper(ctx, info);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  const capsTypeIdx = getOrRegisterThenCapsType(ctx);
  const wrapperId = state.thenWrapperCounter++;
  const wrapperName = `${namePrefix}_${wrapperId}`;
  const capLocal = 2;
  const callbackLocal = 3;
  const resultLocal = 4;
  const funcIdx = mintDefinedFunc(ctx);
  const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, info.funcTypeIdx) ?? info.structTypeIdx;

  const locals: LocalDef[] = [
    { name: "$caps", type: { kind: "ref", typeIdx: capsTypeIdx } },
    { name: "$callback", type: { kind: "ref", typeIdx: selfTypeIdx } },
    { name: "$result", type: { kind: "externref" } },
  ];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: capsTypeIdx },
    { op: "local.set", index: capLocal },
    { op: "local.get", index: capLocal },
    { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: selfTypeIdx },
    { op: "local.set", index: callbackLocal },
  ];

  // (#2867 Gap 2) Run the user `.then`/`.catch` handler inside a try/catch: a
  // handler that THROWS must REJECT the chained promise (spec PerformPromiseThen
  // reject step), not let the exception escape the microtask wrapper uncaught —
  // which traps the entire `__drain_microtasks` pass. Applies uniformly to the
  // fulfill-handler and reject-handler wrappers (the reject arm of
  // `.then(onF, onR)` / `.catch` throwing must also reject the chain). Reuses the
  // module's single exception tag and the native `__promise_reject` settle.
  const exnTag = ensureExnTag(ctx);
  const reasonLocal = 5;
  locals.push({ name: "$reason", type: { kind: "externref" } });

  // Happy path: call the handler, coerce its result, settle the chained promise.
  const tryBody: Instr[] = [
    // call_ref stack shape: [closure_self, ...user_args, typed_funcref]
    { op: "local.get", index: callbackLocal },
  ];
  for (let i = 0; i < info.paramTypes.length; i++) {
    if (i === 0) {
      pushExternrefLocalAsType(ctx, tryBody, 1, info.paramTypes[i]!);
    } else {
      pushDefaultForType(tryBody, info.paramTypes[i]!);
    }
  }
  tryBody.push(
    { op: "local.get", index: callbackLocal },
    { op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 },
    { op: "ref.cast", typeIdx: info.funcTypeIdx },
    { op: "call_ref", typeIdx: info.funcTypeIdx },
  );
  coerceStackValueToExternref(ctx, tryBody, info.returnType);
  tryBody.push(
    { op: "local.set", index: resultLocal },
    { op: "local.get", index: capLocal },
    { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: resultLocal },
    { op: "call", funcIdx: settleFuncIdx },
    { op: "drop" }, // settle returns the value; the drain ignores the wrapper result
  );

  body.push(
    buildTargetTaggedTry(ctx, { kind: "empty" }, tryBody, [
      {
        tagIdx: exnTag,
        body: [
          { op: "local.set", index: reasonLocal },
          { op: "local.get", index: capLocal },
          { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: reasonLocal },
          { op: "call", funcIdx: state.promiseRejectFuncIdx },
          { op: "drop" },
        ],
      },
    ]),
  );
  // Wrapper result (externref) — dropped by the drain; always null now.
  body.push({ op: "ref.null.extern" });

  pushDefinedFunc(ctx, funcIdx, {
    name: wrapperName,
    typeIdx: state.microtaskFuncTypeIdx,
    locals,
    body,
    exported: false,
  });
  ctx.funcMap.set(wrapperName, funcIdx);
  return funcIdx;
}

/**
 * (#4394) Shared per-module DYNAMIC `.then`/`.catch` reaction wrapper —
 * `__then_dyn_fulfill` / `__then_dyn_reject`, uniform microtask signature
 * `(caps externref, value externref) -> externref`.
 *
 * The static wrapper (`emitThenWrapperFunction`) bakes one function per call
 * site from the handler's ClosureInfo and `call_ref`s it directly — which only
 * works when the handler expression resolves to a compile-time closure. The
 * harness `assert.throwsAsync` attaches its captured promise-resolve functions
 * (`res.then(onResFulfilled, onResRejected)`), and tests reassign `$DONE` and
 * pass it by value — pure runtime function values. This wrapper covers them:
 *
 *   - `caps.callback` null (absent/undefined handler) or not a closure-wrapper
 *     struct (non-callable, §27.2.5.4 step 3/4 "empty" reaction): identity —
 *     fulfill resolves the chained promise with the value (resolve-value, so a
 *     promise passthrough still assimilates), reject passes the reason through
 *     to `__promise_reject`.
 *   - callable: `__apply_closure(cb, undefined, [value])`, result settles the
 *     chained promise via resolve-value; a throw REJECTS the chained promise
 *     (same try/catch contract as the static wrapper, #2867 Gap 2).
 *
 * Registered at most once per module per kind; returns undefined (caller falls
 * back to the identity wrappers — the pre-#4394 behaviour) when the object
 * runtime is unavailable.
 */
function ensureDynamicThenWrapper(ctx: CodegenContext, kind: "fulfill" | "reject"): number | undefined {
  ensurePromiseSettleFunctions(ctx);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  const wrapperName = kind === "fulfill" ? "__then_dyn_fulfill" : "__then_dyn_reject";
  const existing = ctx.funcMap.get(wrapperName);
  if (existing !== undefined) return existing;
  if (state.microtaskFuncTypeIdx === -1 || state.promiseResolveValueFuncIdx === -1) return undefined;

  // Deps are append-only mints (defined funcs, no imports) — safe mid-body.
  ensureObjVecBuilders(ctx);
  const applyIdx = reserveApplyClosure(ctx);
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (applyIdx === undefined || objVecNewIdx === undefined || objVecPushIdx === undefined) return undefined;

  const capsTypeIdx = getOrRegisterThenCapsType(ctx);
  const exnTag = ensureExnTag(ctx);
  // Non-callable arm: fulfill = identity resolve-value; reject = pass-through reject.
  const missSettleIdx = kind === "fulfill" ? state.promiseResolveValueFuncIdx : state.promiseRejectFuncIdx;

  const capLocal = 2;
  const cbLocal = 3;
  const resultLocal = 4;
  const reasonLocal = 5;
  const vecLocal = 6;
  const locals: LocalDef[] = [
    { name: "$caps", type: { kind: "ref_null", typeIdx: capsTypeIdx } },
    { name: "$cb", type: { kind: "externref" } },
    { name: "$result", type: { kind: "externref" } },
    { name: "$reason", type: { kind: "externref" } },
    { name: "$argvec", type: { kind: "externref" } },
  ];

  const identityArm: Instr[] = [
    { op: "local.get", index: capLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: missSettleIdx },
    { op: "drop" },
  ];

  const applyArm: Instr[] = [
    buildTargetTaggedTry(
      ctx,
      { kind: "empty" },
      [
        { op: "call", funcIdx: objVecNewIdx },
        { op: "local.set", index: vecLocal },
        { op: "local.get", index: vecLocal },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: objVecPushIdx },
        { op: "local.get", index: cbLocal },
        { op: "ref.null.extern" }, // this = undefined (§27.2.5.4 handler call)
        { op: "local.get", index: vecLocal },
        { op: "call", funcIdx: applyIdx },
        { op: "local.set", index: resultLocal },
        { op: "local.get", index: capLocal },
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
        { op: "local.get", index: resultLocal },
        { op: "call", funcIdx: state.promiseResolveValueFuncIdx },
        { op: "drop" },
      ],
      [
        {
          tagIdx: exnTag,
          body: [
            { op: "local.set", index: reasonLocal },
            { op: "local.get", index: capLocal },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
            { op: "local.get", index: reasonLocal },
            { op: "call", funcIdx: state.promiseRejectFuncIdx },
            { op: "drop" },
          ],
        },
      ],
    ),
  ];

  // IsCallable ≈ "is a closure-wrapper struct" — every compiled function value
  // (user closures, builtin-fn metas, bound functions) subtypes the wrapper
  // root. When no wrapper root exists yet, a non-null callback is applied
  // optimistically (`__apply_closure`'s miss arm answers undefined, no trap).
  const rootTypeIdx = getFuncRefWrapperRootTypeIdx(ctx);
  const callableArm: Instr[] =
    rootTypeIdx === undefined
      ? applyArm
      : [
          { op: "local.get", index: cbLocal },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: rootTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: applyArm,
            else: identityArm.map((i) => ({ ...i })),
          },
        ];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: capsTypeIdx },
    { op: "local.set", index: capLocal },
    { op: "local.get", index: capLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: cbLocal },
    { op: "local.get", index: cbLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: identityArm,
      else: callableArm,
    },
    { op: "ref.null.extern" },
  ];

  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: wrapperName,
    typeIdx: state.microtaskFuncTypeIdx,
    locals,
    body,
    exported: false,
  });
  ctx.funcMap.set(wrapperName, funcIdx);
  return funcIdx;
}

/**
 * #1326 Phase 1C-A — Compile a call to `__microtask_enqueue(fn, caps, arg)`
 * into the caller's body. Caller-supplied `funcRefInstrs` push a funcref;
 * `capsInstrs` push an externref carrying any closure-state captures the
 * drain-time callback will need; `argInstrs` push the externref value to
 * pass to the callback.
 *
 * Used by the standalone `.then` integration to schedule drain-time
 * continuations.
 */
export function emitMicrotaskEnqueue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcRefInstrs: Instr[],
  capsInstrs: Instr[],
  argInstrs: Instr[],
): void {
  ensureMicrotaskQueue(ctx);
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler!;
  for (const i of funcRefInstrs) fctx.body.push(i);
  for (const i of capsInstrs) fctx.body.push(i);
  for (const i of argInstrs) fctx.body.push(i);
  fctx.body.push({ op: "call", funcIdx: state.enqueueFuncIdx });
}

/**
 * #1326 Phase 1C-A — Compile a call to `__drain_microtasks()` into the
 * caller's body. Drains until the queue is empty. Safe to call when the
 * queue was never initialised — the body short-circuits on a null funcs
 * global.
 */
export function emitDrainMicrotasks(ctx: CodegenContext, fctx: FunctionContext): void {
  ensureMicrotaskQueue(ctx);
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler!;
  fctx.body.push({ op: "call", funcIdx: state.drainFuncIdx });
}

/**
 * #1326 Phase 1C-A — If the microtask queue was registered for this
 * compilation unit, export `__drain_microtasks` so standalone callers can
 * invoke it after their top-level entrypoint. Idempotent.
 */
export function exportDrainMicrotasksIfRegistered(ctx: CodegenContext): void {
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler;
  if (!state || state.drainFuncIdx === -1 || state.drainExported) return;
  ctx.mod.exports.push({
    name: "__drain_microtasks",
    desc: { kind: "func", index: state.drainFuncIdx },
  });
  state.drainExported = true;
}

/** Register the two settlement notifications used only by the JS value edge. */
export function ensureNativePromiseBoundaryBridge(ctx: CodegenContext): void {
  if (
    ctx.targetProfile.semanticProviders !== "native-first" ||
    ctx.targetProfile.environment !== "javascript" ||
    ctx.targetProfile.hostValueInterop === "off" ||
    ctx.strictNoHostImports
  ) {
    return;
  }
  ensureLateImport(ctx, "__boundary_promise_resolve", [{ kind: "i32" }, { kind: "externref" }], []);
  ensureLateImport(ctx, "__boundary_promise_reject", [{ kind: "i32" }, { kind: "externref" }], []);
  flushLateImportShifts(ctx, null);
}

/**
 * Export the minimal read-only `$Promise` view needed by the JavaScript value
 * boundary. Promise state and reactions remain Wasm-owned; the host uses these
 * helpers only to present a real JavaScript Promise for an exported native
 * carrier. No-op when this module never registered the native Promise type.
 */
export function exportPromiseBoundaryIfRegistered(ctx: CodegenContext): void {
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler;
  if (!state || state.promiseTypeIdx === -1) return;
  if (ctx.mod.exports.some((entry) => entry.name === "__promise_boundary_state")) return;

  const promiseTypeIdx = state.promiseTypeIdx;
  const stateFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, stateFuncIdx, {
    name: "__promise_boundary_state",
    typeIdx: addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__promise_boundary_state_type"),
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: promiseTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: promiseTypeIdx },
          { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
        ],
        else: [{ op: "i32.const", value: -1 }],
      },
    ],
    exported: true,
  });
  ctx.mod.exports.push({ name: "__promise_boundary_state", desc: { kind: "func", index: stateFuncIdx } });

  const valueFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, valueFuncIdx, {
    name: "__promise_boundary_value",
    typeIdx: addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$__promise_boundary_value_type"),
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: promiseTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: promiseTypeIdx },
          { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
        ],
        else: [{ op: "ref.null.extern" }],
      },
    ],
    exported: true,
  });
  ctx.mod.exports.push({ name: "__promise_boundary_value", desc: { kind: "func", index: valueFuncIdx } });

  const resolveImportIdx = ctx.funcMap.get("__boundary_promise_resolve");
  const rejectImportIdx = ctx.funcMap.get("__boundary_promise_reject");
  if (resolveImportIdx === undefined || rejectImportIdx === undefined) return;

  ensureMicrotaskQueue(ctx);
  const callbackTypeIdx = getOrRegisterPromiseCallbackType(ctx);
  const capsTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$__promise_boundary_caps",
    fields: [{ name: "id", type: { kind: "i32" }, mutable: false }],
  });

  const makeNotificationWrapper = (name: string, importIdx: number): number => {
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx: state.microtaskFuncTypeIdx,
      locals: [],
      body: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: capsTypeIdx },
        { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: importIdx },
        { op: "ref.null.extern" },
      ],
      exported: false,
    });
    return funcIdx;
  };
  const resolveWrapperIdx = makeNotificationWrapper("__promise_boundary_resolve_task", resolveImportIdx);
  const rejectWrapperIdx = makeNotificationWrapper("__promise_boundary_reject_task", rejectImportIdx);

  const observeFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, observeFuncIdx, {
    name: "__promise_boundary_observe",
    typeIdx: addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$__promise_boundary_observe_type",
    ),
    locals: [
      { name: "$promise", type: { kind: "ref", typeIdx: promiseTypeIdx } },
      { name: "$caps", type: { kind: "externref" } },
    ],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: promiseTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: promiseTypeIdx },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 1 },
      { op: "struct.new", typeIdx: capsTypeIdx },
      { op: "extern.convert_any" },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: PROMISE_STATE_FULFILLED },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
          { op: "call", funcIdx: resolveImportIdx },
          { op: "i32.const", value: 1 },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: PROMISE_STATE_REJECTED },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
          { op: "call", funcIdx: rejectImportIdx },
          { op: "i32.const", value: 1 },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 2 },
      { op: "ref.func", funcIdx: resolveWrapperIdx },
      { op: "local.get", index: 3 },
      { op: "ref.func", funcIdx: rejectWrapperIdx },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 2 },
      { op: "struct.new", typeIdx: callbackTypeIdx },
      { op: "extern.convert_any" },
      { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: 1 },
    ],
    exported: true,
  });
  ctx.mod.exports.push({ name: "__promise_boundary_observe", desc: { kind: "func", index: observeFuncIdx } });
}

/**
 * The stable runtime handles the host-free async drive layer (#2895 PATH B)
 * depends on: the native `$Promise` carrier + its `$PromiseCallback` reaction
 * node, the microtask ring, and the one-shot settle helpers. All of these are
 * the SAME substrate the standalone `.then` machinery
 * ({@link emitStandalonePromiseThen}) and the WASI async path already use — the
 * async frame driver reuses them rather than forking a parallel scheduler.
 */
export interface AsyncDriveRuntime {
  /** `$Promise` struct typeIdx (`{state i32, value externref, callbacks externref}`). */
  promiseTypeIdx: number;
  /** `$PromiseCallback` reaction-node typeIdx ({@link getOrRegisterPromiseCallbackTypeIdx}). */
  callbackTypeIdx: number;
  /** `__promise_fulfill(promise, value) -> value` funcIdx (settles + drains callbacks). */
  fulfillFuncIdx: number;
  /** `__promise_reject(promise, value) -> value` funcIdx. */
  rejectFuncIdx: number;
  /** `__microtask_enqueue(funcref, caps externref, value externref)` funcIdx. */
  enqueueFuncIdx: number;
  /** `__drain_microtasks()` funcIdx. */
  drainFuncIdx: number;
  /**
   * (#2958) `__mark_rejection_handled(p eqref)` funcIdx, or -1 when the
   * unhandled-rejection substrate is inactive (non-wasi). A consumer that
   * attaches a reaction to a promise (`await`, a combinator input) calls this so
   * a born-rejected input (e.g. an inlined `Promise.reject(x)`) is not reported
   * as unhandled.
   */
  markRejectionHandledFuncIdx: number;
}

/**
 * (#2895 PATH B) Idempotently register the full async-drive runtime substrate
 * (Promise type, reaction node, microtask ring, settle helpers) and return the
 * stable func/type indices. Must be invoked BEFORE emitting any function body
 * that bakes these `call`/`struct.new` indices — registering mid-body would
 * shift subsequent funcIdx values (the late-import-shift hazard #1677/#1809).
 * The async frame driver calls this from its prepass / call-site emission, which
 * runs before the resume function body is filled.
 */
export function ensureAsyncDriveRuntime(ctx: CodegenContext): AsyncDriveRuntime {
  ensureMicrotaskQueue(ctx);
  ensurePromiseSettleFunctions(ctx);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  return {
    promiseTypeIdx: getOrRegisterPromiseType(ctx),
    callbackTypeIdx: getOrRegisterPromiseCallbackType(ctx),
    fulfillFuncIdx: state.promiseFulfillFuncIdx,
    rejectFuncIdx: state.promiseRejectFuncIdx,
    enqueueFuncIdx: state.enqueueFuncIdx,
    drainFuncIdx: state.drainFuncIdx,
    markRejectionHandledFuncIdx: state.markRejectionHandledFuncIdx,
  };
}

/**
 * #1326 Phase 1C-A — Auto-drain hook for WASI `_start`. Returns the funcIdx
 * of `__drain_microtasks` when the queue is registered, or `null` when not
 * (queue was never used by this module; no drain call needed). Callers
 * append `{ op: "call", funcIdx: <returned> }` to the `_start` body right
 * after the main/`__module_init` call.
 */
export function getDrainFuncIdxForWasiStart(ctx: CodegenContext): number | null {
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler;
  if (!state || state.drainFuncIdx === -1) return null;
  return state.drainFuncIdx;
}

// ── #2632 Phase 1 — timer heap + run-loop reactor ────────────────────────
//
// The reactor composes the EXISTING substrate into a single-threaded
// cooperative event loop for the `--target wasi` WasmGC+linear path:
//
//   - the #1326 microtask queue (`__drain_microtasks`),
//   - a timer table (parallel WasmGC arrays keyed by deadline-ns), and
//   - the #1484 single-clock `poll_oneoff` sleep (`__wasi_sleep_ms`),
//   - CLOCK_MONOTONIC via `clock_time_get`,
//
// into `__run_event_loop`, which replaces the one-shot `__drain_microtasks`
// call in the WASI `_start` wrapper. When the timer table is empty the loop
// drains microtasks once and exits — byte-effect-equivalent to the old
// one-shot drain (the run loop is a strict superset of the drain).
//
// Timer table model (no binary heap — a linear scan finds the earliest live
// deadline; timer counts are tiny so O(n) per tick is fine and far less
// error-prone than a hand-rolled WasmGC binary heap):
//   deadlines[i]  : i64  absolute fire time in monotonic ns
//   callbacks[i]  : funcref ($__mt_func_type: (caps externref, val externref) -> externref)
//   captures[i]   : externref  closure captures passed to the callback
//   intervals[i]  : i64  re-arm period in ns (0 = one-shot setTimeout)
//   cancelled[i]  : i32  1 = cancelled (lazy delete)
// `count` is the high-water slot count; a cancelled / fired one-shot slot is
// marked by setting cancelled[i]=1 (fired one-shots) so the scan skips it.

const TIMER_QUEUE_INITIAL_SLOTS = 64;
// Run-loop scratch offsets (inside the reserved 0..1023 bump zone, between the
// clock-helpers' 16..31 region and `__wasi_sleep_ms`'s 64..147 region).
const RL_NOW_OUT_OFFSET = 48; // i64 monotonic-now out-ptr for clock_time_get

// ── #2632 Phase 2 — fd-readiness reactor scratch + buffer constants ──────
//
// The multi-subscription poll scratch lives ABOVE `__wasi_sleep_ms`'s 64..147
// region so the two paths never alias (a program can register both — the
// single-clock sleep is unused on the fd-reactor path, but the helper still
// exists). Layout inside the reserved page-0 bump zone (160..303):
//   [160..207]  subscription_t[0] (48 bytes) — FD_READ on fd 0
//   [208..255]  subscription_t[1] (48 bytes) — CLOCK on CLOCK_MONOTONIC
//   [256..319]  event_t[0..1] out buffer (32 bytes each, 2 events max)
//   [320..323]  nevents out (u32)
//   [324..335]  fd_read iovec scratch (iov_base @324, iov_len @328, nread @332)
const RL_POLL_SUB0_OFFSET = 160; // fd0 FD_READ subscription
const RL_POLL_SUB1_OFFSET = 208; // clock subscription
const RL_POLL_EVT_OFFSET = 256; // event_t out buffer (2 events)
const RL_POLL_NEVENTS_OFFSET = 320; // nevents out u32
const RL_FDREAD_IOV_OFFSET = 324; // iovec (base,len) for fd_read
const RL_FDREAD_NREAD_OFFSET = 332; // nread out u32 for fd_read

// Internal stdin accumulation buffer. Reuses the page-1 stdin region (#1653,
// WASI_STDIN_BUF_START = 64 KiB). Defined locally to avoid a circular import
// from index.ts; MUST stay in sync with that export.
const RL_STDIN_BUF_START = 64 * 1024;
const RL_STDIN_BUF_CAP = 64 * 1024; // one page

/**
 * #2632 — Idempotently register the timer table (types, globals, helpers) and
 * the run-loop driver. MUST be called in the deferred-helper phase (after
 * `__wasi_sleep_ms` + `clock_time_get` are registered, before user bodies
 * compile) so the `__timer_add` / `__timer_cancel` func indices referenced at
 * timer call sites are final. Depends on `ensureMicrotaskQueue` (the loop
 * drains microtasks each tick).
 */
export function ensureTimerHeap(ctx: CodegenContext): void {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.timerHeapRegistered) return;

  // The run loop drains microtasks — guarantee the queue exists first so its
  // func indices (drain/enqueue) are stable below.
  ensureMicrotaskQueue(ctx);

  // The microtask queue already registered $__mt_func_type — reuse it as the
  // uniform timer-callback signature so a timer callback and a microtask
  // continuation are call_ref-compatible.
  const mtFuncTypeIdx = state.microtaskFuncTypeIdx;

  // ── 1. Types ──────────────────────────────────────────────────────────
  // funcref array for callbacks (own typeIdx — funcref arrays are not keyed by
  // getOrRegisterArrayType, mirroring the microtask queue's $__arr_mt_func).
  const funcArrIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "__arr_timer_func",
    element: { kind: "funcref" } as ValType,
    mutable: true,
  } as unknown as import("../ir/types.js").ArrayTypeDef);
  state.timerFuncArrTypeIdx = funcArrIdx;

  const i64ArrIdx = getOrRegisterArrayType(ctx, "i64", { kind: "i64" });
  state.timerI64ArrTypeIdx = i64ArrIdx;
  const i32ArrIdx = getOrRegisterArrayType(ctx, "i32", { kind: "i32" });
  state.timerI32ArrTypeIdx = i32ArrIdx;
  const externArrIdx = getOrRegisterMicrotaskQueueType(ctx); // $__arr_externref

  // ── 2. Globals ────────────────────────────────────────────────────────
  const baseGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  state.timerCountGlobalIdx = baseGlobalIdx;
  ctx.mod.globals.push({
    name: "__timer_count",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  state.timerCapGlobalIdx = baseGlobalIdx + 1;
  ctx.mod.globals.push({
    name: "__timer_cap",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  state.timerDeadlinesGlobalIdx = baseGlobalIdx + 2;
  ctx.mod.globals.push({
    name: "__timer_deadlines",
    type: { kind: "ref_null", typeIdx: i64ArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: i64ArrIdx }],
  });
  state.timerCallbacksGlobalIdx = baseGlobalIdx + 3;
  ctx.mod.globals.push({
    name: "__timer_callbacks",
    type: { kind: "ref_null", typeIdx: funcArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: funcArrIdx }],
  });
  state.timerCapturesGlobalIdx = baseGlobalIdx + 4;
  ctx.mod.globals.push({
    name: "__timer_captures",
    type: { kind: "ref_null", typeIdx: externArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: externArrIdx }],
  });
  state.timerIntervalsGlobalIdx = baseGlobalIdx + 5;
  ctx.mod.globals.push({
    name: "__timer_intervals",
    type: { kind: "ref_null", typeIdx: i64ArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: i64ArrIdx }],
  });
  state.timerCancelledGlobalIdx = baseGlobalIdx + 6;
  ctx.mod.globals.push({
    name: "__timer_cancelled",
    type: { kind: "ref_null", typeIdx: i32ArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: i32ArrIdx }],
  });

  // #2632 Phase 2 — fd-readiness reactor globals. Registered ONLY when the
  // stdin reactor is active (a program that references `process.stdin` under
  // --target wasi), so timer-only programs keep Phase 1's exact global table
  // and stay byte-identical.
  if (state.stdinReactor) {
    const rlBase = ctx.numImportGlobals + ctx.mod.globals.length;
    state.stdinNonblockSetGlobalIdx = rlBase;
    ctx.mod.globals.push({
      name: "__stdin_nonblock_set",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    state.stdinFdActiveGlobalIdx = rlBase + 1;
    ctx.mod.globals.push({
      name: "__stdin_fd_active",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 1 }], // fd0 starts subscribed (until EOF)
    });
    state.stdinBufLenGlobalIdx = rlBase + 2;
    ctx.mod.globals.push({
      name: "__stdin_buf_len",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    state.stdinBufPosGlobalIdx = rlBase + 3;
    ctx.mod.globals.push({
      name: "__stdin_buf_pos",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    // #2632 Phase 3 — reactor-tick hook: the process.stdin Readable's pump
    // callback (uniform `$__mt_func_type` funcref, nullable) + its closure
    // captures (the bound Readable instance). The run loop call_ref's the hook
    // each tick after the drain, passing the captures as the first arg. Null
    // until the library calls `__wasiStdinSetReader(cb)`.
    state.stdinReaderHookGlobalIdx = rlBase + 4;
    ctx.mod.globals.push({
      name: "__stdin_reader_hook",
      type: { kind: "ref_null", typeIdx: mtFuncTypeIdx },
      mutable: true,
      init: [{ op: "ref.null", typeIdx: mtFuncTypeIdx }],
    });
    state.stdinReaderCapGlobalIdx = rlBase + 5;
    ctx.mod.globals.push({
      name: "__stdin_reader_cap",
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
  }

  // ── 3. Helper functions (push order = funcIdx order) ──────────────────
  // grow → add → cancel → peek → fire_due → now
  //   → (Phase 2: stdin_drain → poll_fd0_or_clock) → run_loop.
  const growIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, growIdx, {
    name: "__timer_grow",
    typeIdx: addFuncType(ctx, [{ kind: "i32" }], [], "$__timer_grow_type"),
    locals: buildTimerGrowLocals(state),
    body: buildTimerGrowBody(state, funcArrIdx, i64ArrIdx, i32ArrIdx, externArrIdx),
    exported: false,
  });
  ctx.funcMap.set("__timer_grow", growIdx);

  state.timerAddFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, state.timerAddFuncIdx, {
    name: "__timer_add",
    typeIdx: addFuncType(
      ctx,
      [{ kind: "i64" }, { kind: "funcref" } as ValType, { kind: "externref" }, { kind: "i64" }],
      [{ kind: "i32" }],
      "$__timer_add_type",
    ),
    locals: [],
    body: buildTimerAddBody(state, growIdx, funcArrIdx, i64ArrIdx, i32ArrIdx, externArrIdx),
    exported: false,
  });
  ctx.funcMap.set("__timer_add", state.timerAddFuncIdx);

  state.timerCancelFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, state.timerCancelFuncIdx, {
    name: "__timer_cancel",
    typeIdx: addFuncType(ctx, [{ kind: "i32" }], [], "$__timer_cancel_type"),
    locals: [],
    body: buildTimerCancelBody(state, i32ArrIdx),
    exported: false,
  });
  ctx.funcMap.set("__timer_cancel", state.timerCancelFuncIdx);

  state.timerPeekDeadlineFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, state.timerPeekDeadlineFuncIdx, {
    name: "__timer_peek_deadline",
    typeIdx: addFuncType(ctx, [], [{ kind: "i64" }], "$__timer_peek_type"),
    locals: buildTimerPeekLocals(),
    body: buildTimerPeekBody(state, i64ArrIdx, i32ArrIdx),
    exported: false,
  });
  ctx.funcMap.set("__timer_peek_deadline", state.timerPeekDeadlineFuncIdx);

  state.timerFireDueFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, state.timerFireDueFuncIdx, {
    name: "__timer_fire_due",
    typeIdx: addFuncType(ctx, [{ kind: "i64" }], [], "$__timer_fire_type"),
    locals: buildTimerFireLocals(state, mtFuncTypeIdx),
    body: buildTimerFireBody(state, mtFuncTypeIdx, funcArrIdx, i64ArrIdx, i32ArrIdx, externArrIdx),
    exported: false,
  });
  ctx.funcMap.set("__timer_fire_due", state.timerFireDueFuncIdx);

  // Monotonic-now reader. clock_time_get(CLOCK_MONOTONIC=1, precision, out) →
  // i64 ns recombined from two i32 loads (the binary emitter has no i64.load).
  const clockIdx = ctx.wasiClockTimeGetIdx;
  state.runLoopNowFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, state.runLoopNowFuncIdx, {
    name: "__rl_now_ns",
    typeIdx: addFuncType(ctx, [], [{ kind: "i64" }], "$__rl_now_type"),
    locals: [],
    body: buildRunLoopNowBody(clockIdx),
    exported: false,
  });
  ctx.funcMap.set("__rl_now_ns", state.runLoopNowFuncIdx);

  // #2632 Phase 2 — fd-readiness reactor helpers. Registered ONLY when the
  // stdin reactor is active, BETWEEN __rl_now_ns and __run_event_loop (the run
  // loop calls them). When inactive, the run-loop func idx stays baseFuncIdx+6
  // exactly as Phase 1, preserving byte-neutrality for timer-only programs.
  if (state.stdinReactor) {
    // __rl_stdin_drain() -> i32 : non-blocking fd_read available bytes from fd0
    // into the internal stdin buffer; returns bytes read (0 = EOF → drop the
    // fd subscription). Reuses the page-1 stdin buffer (WASI_STDIN_BUF_START).
    state.stdinDrainFuncIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, state.stdinDrainFuncIdx, {
      name: "__rl_stdin_drain",
      typeIdx: addFuncType(ctx, [], [{ kind: "i32" }], "$__rl_stdin_drain_type"),
      locals: buildStdinDrainLocals(),
      body: buildStdinDrainBody(ctx, state),
      exported: false,
    });
    ctx.funcMap.set("__rl_stdin_drain", state.stdinDrainFuncIdx);

    // __rl_poll_fd0_or_clock(deadlineNs i64, nowNs i64) -> i32 : multi-sub
    // poll_oneoff on (fd0 readable, nearest-timer clock). Returns 1 if fd0 is
    // readable, else 0 (clock fired / timeout). When no timer is pending
    // (deadline == I64_MAX) it polls fd0 alone (blocking until readable/EOF).
    state.pollFd0OrClockFuncIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, state.pollFd0OrClockFuncIdx, {
      name: "__rl_poll_fd0_or_clock",
      typeIdx: addFuncType(ctx, [{ kind: "i64" }, { kind: "i64" }], [{ kind: "i32" }], "$__rl_poll_fd0_type"),
      locals: buildPollFd0Locals(),
      body: buildPollFd0OrClockBody(ctx, state),
      exported: false,
    });
    ctx.funcMap.set("__rl_poll_fd0_or_clock", state.pollFd0OrClockFuncIdx);
  }

  // The run loop references __wasi_sleep_ms by funcIdx; it was registered
  // earlier in the deferred-helper phase (needsPollOneoff). Resolve now.
  const sleepMsIdx = ctx.funcMap.get("__wasi_sleep_ms");
  state.runLoopFuncIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, state.runLoopFuncIdx, {
    name: "__run_event_loop",
    typeIdx: addFuncType(ctx, [], [], "$__run_event_loop_type"),
    locals: buildRunLoopLocals(state),
    body: buildRunLoopBody(state, sleepMsIdx),
    exported: false,
  });
  ctx.funcMap.set("__run_event_loop", state.runLoopFuncIdx);

  state.timerHeapRegistered = true;
}

function buildTimerGrowLocals(_state: AsyncSchedulerState): import("../ir/types.js").LocalDef[] {
  // Param 0: $newCap (i32).
  return [
    { name: "$oldDeadlines", type: { kind: "ref_null", typeIdx: _state.timerI64ArrTypeIdx } },
    { name: "$oldCallbacks", type: { kind: "ref_null", typeIdx: _state.timerFuncArrTypeIdx } },
    { name: "$oldCaptures", type: { kind: "ref_null", typeIdx: _state.microtaskArgsArrTypeIdx } },
    { name: "$oldIntervals", type: { kind: "ref_null", typeIdx: _state.timerI64ArrTypeIdx } },
    { name: "$oldCancelled", type: { kind: "ref_null", typeIdx: _state.timerI32ArrTypeIdx } },
    { name: "$count", type: { kind: "i32" } },
    { name: "$i", type: { kind: "i32" } },
  ];
}

function buildTimerGrowBody(
  state: AsyncSchedulerState,
  funcArrIdx: number,
  i64ArrIdx: number,
  i32ArrIdx: number,
  externArrIdx: number,
): Instr[] {
  const newCap = 0;
  const oldDl = 1;
  const oldCb = 2;
  const oldCap = 3;
  const oldIv = 4;
  const oldCn = 5;
  const count = 6;
  const i = 7;

  return [
    // Snapshot old arrays + count.
    { op: "global.get", index: state.timerDeadlinesGlobalIdx },
    { op: "local.set", index: oldDl },
    { op: "global.get", index: state.timerCallbacksGlobalIdx },
    { op: "local.set", index: oldCb },
    { op: "global.get", index: state.timerCapturesGlobalIdx },
    { op: "local.set", index: oldCap },
    { op: "global.get", index: state.timerIntervalsGlobalIdx },
    { op: "local.set", index: oldIv },
    { op: "global.get", index: state.timerCancelledGlobalIdx },
    { op: "local.set", index: oldCn },
    { op: "global.get", index: state.timerCountGlobalIdx },
    { op: "local.set", index: count },

    // Allocate new arrays of $newCap (default-initialised).
    { op: "i64.const", value: 0n },
    { op: "local.get", index: newCap },
    { op: "array.new", typeIdx: i64ArrIdx },
    { op: "global.set", index: state.timerDeadlinesGlobalIdx },

    { op: "ref.null.func" },
    { op: "local.get", index: newCap },
    { op: "array.new", typeIdx: funcArrIdx },
    { op: "global.set", index: state.timerCallbacksGlobalIdx },

    { op: "ref.null.extern" },
    { op: "local.get", index: newCap },
    { op: "array.new", typeIdx: externArrIdx },
    { op: "global.set", index: state.timerCapturesGlobalIdx },

    { op: "i64.const", value: 0n },
    { op: "local.get", index: newCap },
    { op: "array.new", typeIdx: i64ArrIdx },
    { op: "global.set", index: state.timerIntervalsGlobalIdx },

    { op: "i32.const", value: 0 },
    { op: "local.get", index: newCap },
    { op: "array.new", typeIdx: i32ArrIdx },
    { op: "global.set", index: state.timerCancelledGlobalIdx },

    // If oldDeadlines null → nothing to copy; set cap and return.
    { op: "local.get", index: oldDl },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "local.get", index: newCap },
        { op: "global.set", index: state.timerCapGlobalIdx },
        { op: "return" },
      ],
    },

    // Copy [0, count) into the fresh arrays (compaction not needed — ids stay
    // stable so live clearTimeout(id) keeps working).
    { op: "i32.const", value: 0 },
    { op: "local.set", index: i },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: i },
            { op: "local.get", index: count },
            { op: "i32.eq" },
            { op: "br_if", depth: 1 },

            // deadlines[i] = old
            { op: "global.get", index: state.timerDeadlinesGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "local.get", index: oldDl },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: i64ArrIdx },
            { op: "array.set", typeIdx: i64ArrIdx },

            // callbacks[i] = old
            { op: "global.get", index: state.timerCallbacksGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "local.get", index: oldCb },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: funcArrIdx },
            { op: "array.set", typeIdx: funcArrIdx },

            // captures[i] = old
            { op: "global.get", index: state.timerCapturesGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "local.get", index: oldCap },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: externArrIdx },
            { op: "array.set", typeIdx: externArrIdx },

            // intervals[i] = old
            { op: "global.get", index: state.timerIntervalsGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "local.get", index: oldIv },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: i64ArrIdx },
            { op: "array.set", typeIdx: i64ArrIdx },

            // cancelled[i] = old
            { op: "global.get", index: state.timerCancelledGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "local.get", index: oldCn },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: i32ArrIdx },
            { op: "array.set", typeIdx: i32ArrIdx },

            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    { op: "local.get", index: newCap },
    { op: "global.set", index: state.timerCapGlobalIdx },
  ];
}

function buildTimerAddBody(
  state: AsyncSchedulerState,
  growIdx: number,
  funcArrIdx: number,
  i64ArrIdx: number,
  _i32ArrIdx: number,
  externArrIdx: number,
): Instr[] {
  // Params: 0=deadlineNs(i64) 1=cb(funcref) 2=cap(externref) 3=intervalNs(i64)
  const deadline = 0;
  const cb = 1;
  const cap = 2;
  const interval = 3;

  return [
    // Lazy first-allocate when callbacks global is null.
    { op: "global.get", index: state.timerCallbacksGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "i32.const", value: TIMER_QUEUE_INITIAL_SLOTS },
        { op: "call", funcIdx: growIdx },
      ],
    },
    // If count == cap, double.
    { op: "global.get", index: state.timerCountGlobalIdx },
    { op: "global.get", index: state.timerCapGlobalIdx },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "global.get", index: state.timerCapGlobalIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.shl" },
        { op: "call", funcIdx: growIdx },
      ],
    },

    // slot = count; write fields.
    { op: "global.get", index: state.timerDeadlinesGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "global.get", index: state.timerCountGlobalIdx },
    { op: "local.get", index: deadline },
    { op: "array.set", typeIdx: i64ArrIdx },

    { op: "global.get", index: state.timerCallbacksGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "global.get", index: state.timerCountGlobalIdx },
    { op: "local.get", index: cb },
    { op: "array.set", typeIdx: funcArrIdx },

    { op: "global.get", index: state.timerCapturesGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "global.get", index: state.timerCountGlobalIdx },
    { op: "local.get", index: cap },
    { op: "array.set", typeIdx: externArrIdx },

    { op: "global.get", index: state.timerIntervalsGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "global.get", index: state.timerCountGlobalIdx },
    { op: "local.get", index: interval },
    { op: "array.set", typeIdx: i64ArrIdx },

    // cancelled[slot] is already 0 from array.new default.

    // id = count; count++; return id.
    { op: "global.get", index: state.timerCountGlobalIdx },
    { op: "global.get", index: state.timerCountGlobalIdx },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "global.set", index: state.timerCountGlobalIdx },
    // (id left on stack as result)
  ];
}

function buildTimerCancelBody(state: AsyncSchedulerState, i32ArrIdx: number): Instr[] {
  // Param 0 = id (i32). Lazy delete: bounds-check then set cancelled[id]=1.
  const id = 0;
  return [
    { op: "global.get", index: state.timerCancelledGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [{ op: "return" }],
    },
    // if id < 0 || id >= count: return
    { op: "local.get", index: id },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [{ op: "return" }],
    },
    { op: "local.get", index: id },
    { op: "global.get", index: state.timerCountGlobalIdx },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [{ op: "return" }],
    },
    { op: "global.get", index: state.timerCancelledGlobalIdx },
    { op: "ref.as_non_null" },
    { op: "local.get", index: id },
    { op: "i32.const", value: 1 },
    { op: "array.set", typeIdx: i32ArrIdx },
  ];
}

function buildTimerPeekLocals(): import("../ir/types.js").LocalDef[] {
  return [
    { name: "$i", type: { kind: "i32" } },
    { name: "$best", type: { kind: "i64" } },
    { name: "$d", type: { kind: "i64" } },
  ];
}

const I64_MAX = 0x7fffffffffffffffn;

function buildTimerPeekBody(state: AsyncSchedulerState, i64ArrIdx: number, i32ArrIdx: number): Instr[] {
  // Linear scan of live (non-cancelled) timers; return the minimum deadline,
  // or i64 max when none. The run loop compares against i64 max to detect "no
  // pending timers".
  const i = 0;
  const best = 1;
  const d = 2;
  return [
    { op: "i64.const", value: I64_MAX },
    { op: "local.set", index: best },
    { op: "global.get", index: state.timerCallbacksGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [{ op: "local.get", index: best }, { op: "return" }],
    },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: i },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: i },
            { op: "global.get", index: state.timerCountGlobalIdx },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // skip if cancelled[i] != 0
            { op: "global.get", index: state.timerCancelledGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: i32ArrIdx },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" } as any,
              then: [
                // d = deadlines[i]
                { op: "global.get", index: state.timerDeadlinesGlobalIdx },
                { op: "ref.as_non_null" },
                { op: "local.get", index: i },
                { op: "array.get", typeIdx: i64ArrIdx },
                { op: "local.set", index: d },
                // if d < best: best = d
                { op: "local.get", index: d },
                { op: "local.get", index: best },
                { op: "i64.lt_s" },
                {
                  op: "if",
                  blockType: { kind: "empty" } as any,
                  then: [
                    { op: "local.get", index: d },
                    { op: "local.set", index: best },
                  ],
                },
              ],
            },

            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: best },
  ];
}

function buildTimerFireLocals(state: AsyncSchedulerState, _mtFuncTypeIdx: number): import("../ir/types.js").LocalDef[] {
  return [
    { name: "$i", type: { kind: "i32" } },
    { name: "$fn", type: { kind: "funcref" } as ValType },
    { name: "$cap", type: { kind: "externref" } },
    { name: "$iv", type: { kind: "i64" } },
    { name: "$dl", type: { kind: "i64" } },
  ];
}

function buildTimerFireBody(
  state: AsyncSchedulerState,
  mtFuncTypeIdx: number,
  funcArrIdx: number,
  i64ArrIdx: number,
  i32ArrIdx: number,
  externArrIdx: number,
): Instr[] {
  // Param 0 = nowNs (i64). Single pass over [0,count): every live timer whose
  // deadline <= now fires once. A one-shot is then marked cancelled; an
  // interval is re-armed (deadline += period) so it can fire again on a later
  // tick. Re-arming in place keeps the id stable for clearInterval.
  //
  // A callback that schedules a NEW timer appends past `count`; we snapshot
  // count at entry implicitly by reading the global each iteration but only
  // process indices < the count observed at loop test — newly added timers
  // (index >= old count) are picked up by the next run-loop tick, matching
  // Node (a timer scheduled inside a timer callback runs on a later turn).
  const nowNs = 0;
  const i = 1;
  const fn = 2;
  const cap = 3;
  const iv = 4;
  const dl = 5;

  return [
    { op: "global.get", index: state.timerCallbacksGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [{ op: "return" }],
    },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: i },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: i },
            { op: "global.get", index: state.timerCountGlobalIdx },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // live = cancelled[i] == 0
            { op: "global.get", index: state.timerCancelledGlobalIdx },
            { op: "ref.as_non_null" },
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: i32ArrIdx },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" } as any,
              then: [
                // dl = deadlines[i]
                { op: "global.get", index: state.timerDeadlinesGlobalIdx },
                { op: "ref.as_non_null" },
                { op: "local.get", index: i },
                { op: "array.get", typeIdx: i64ArrIdx },
                { op: "local.set", index: dl },
                // due = dl <= now
                { op: "local.get", index: dl },
                { op: "local.get", index: nowNs },
                { op: "i64.le_s" },
                {
                  op: "if",
                  blockType: { kind: "empty" } as any,
                  then: [
                    // iv = intervals[i]
                    { op: "global.get", index: state.timerIntervalsGlobalIdx },
                    { op: "ref.as_non_null" },
                    { op: "local.get", index: i },
                    { op: "array.get", typeIdx: i64ArrIdx },
                    { op: "local.set", index: iv },

                    // Re-arm or retire BEFORE invoking, so a callback that
                    // calls clearInterval(id) on itself still cancels the next
                    // fire (it sets cancelled[i]=1 over our re-arm here).
                    { op: "local.get", index: iv },
                    { op: "i64.const", value: 0n },
                    { op: "i64.gt_s" },
                    {
                      op: "if",
                      blockType: { kind: "empty" } as any,
                      then: [
                        // interval: deadlines[i] = dl + iv (re-arm relative to
                        // the scheduled deadline so cadence doesn't drift).
                        { op: "global.get", index: state.timerDeadlinesGlobalIdx },
                        { op: "ref.as_non_null" },
                        { op: "local.get", index: i },
                        { op: "local.get", index: dl },
                        { op: "local.get", index: iv },
                        { op: "i64.add" },
                        { op: "array.set", typeIdx: i64ArrIdx },
                      ],
                      else: [
                        // one-shot: mark cancelled so it never fires again.
                        { op: "global.get", index: state.timerCancelledGlobalIdx },
                        { op: "ref.as_non_null" },
                        { op: "local.get", index: i },
                        { op: "i32.const", value: 1 },
                        { op: "array.set", typeIdx: i32ArrIdx },
                      ],
                    },

                    // Load callback + captures.
                    { op: "global.get", index: state.timerCallbacksGlobalIdx },
                    { op: "ref.as_non_null" },
                    { op: "local.get", index: i },
                    { op: "array.get", typeIdx: funcArrIdx },
                    { op: "local.set", index: fn },
                    { op: "global.get", index: state.timerCapturesGlobalIdx },
                    { op: "ref.as_non_null" },
                    { op: "local.get", index: i },
                    { op: "array.get", typeIdx: externArrIdx },
                    { op: "local.set", index: cap },

                    // Invoke fn(cap, null) via call_ref (uniform $__mt_func_type).
                    { op: "local.get", index: cap },
                    { op: "ref.null.extern" },
                    { op: "local.get", index: fn },
                    { op: "ref.cast", typeIdx: mtFuncTypeIdx },
                    { op: "call_ref", typeIdx: mtFuncTypeIdx },
                    { op: "drop" },
                  ],
                },
              ],
            },

            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}

function buildRunLoopNowBody(clockIdx: number | undefined): Instr[] {
  // clock_time_get(CLOCK_MONOTONIC=1, precision=1us, out=RL_NOW_OUT_OFFSET) then
  // recombine the LE u64 from two i32 loads (binary emitter lacks i64.load).
  if (clockIdx === undefined || clockIdx < 0) {
    // Safety: no clock import → return 0 (timers all appear immediately due).
    return [{ op: "i64.const", value: 0n }];
  }
  return [
    { op: "i32.const", value: 1 }, // CLOCK_MONOTONIC
    { op: "i64.const", value: 1000n }, // precision 1us
    { op: "i32.const", value: RL_NOW_OUT_OFFSET },
    { op: "call", funcIdx: clockIdx },
    { op: "drop" },
    // hi << 32 | lo
    { op: "i32.const", value: RL_NOW_OUT_OFFSET + 4 },
    { op: "i32.load", align: 2, offset: 0 },
    { op: "i64.extend_i32_u" },
    { op: "i64.const", value: 32n },
    { op: "i64.shl" },
    { op: "i32.const", value: RL_NOW_OUT_OFFSET },
    { op: "i32.load", align: 2, offset: 0 },
    { op: "i64.extend_i32_u" },
    { op: "i64.or" },
  ];
}

function buildRunLoopLocals(state: AsyncSchedulerState): import("../ir/types.js").LocalDef[] {
  const locals: import("../ir/types.js").LocalDef[] = [
    { name: "$now", type: { kind: "i64" } },
    { name: "$next", type: { kind: "i64" } },
    { name: "$waitMs", type: { kind: "i64" } },
  ];
  if (state.stdinReactor) {
    // $pending: i32 — 1 while any timer OR the fd0 subscription is still live.
    locals.push({ name: "$pending", type: { kind: "i32" } });
  }
  return locals;
}

function buildRunLoopBody(state: AsyncSchedulerState, sleepMsIdx: number | undefined): Instr[] {
  if (state.stdinReactor) return buildRunLoopBodyWithFdReactor(state);

  const now = 0;
  const next = 1;
  const waitMs = 2;

  // Each tick:
  //   drain microtasks → now = clock → fire due timers (which may enqueue more
  //   microtasks / timers) → drain again → next = peek_deadline.
  //   if next == i64_max: no pending timers → exit.
  //   else: waitMs = ceil((next-now)/1e6); if waitMs > 0 sleep that long; loop.
  // The post-fire drain settles any Promise reactions a timer callback queued
  // before we decide whether to block, so a `setTimeout(()=>p.then(...))`
  // chain runs its microtasks promptly.
  const tickBody: Instr[] = [
    { op: "call", funcIdx: state.drainFuncIdx },
    { op: "call", funcIdx: state.runLoopNowFuncIdx },
    { op: "local.set", index: now },
    { op: "local.get", index: now },
    { op: "call", funcIdx: state.timerFireDueFuncIdx },
    { op: "call", funcIdx: state.drainFuncIdx },

    // next = peek
    { op: "call", funcIdx: state.timerPeekDeadlineFuncIdx },
    { op: "local.set", index: next },

    // if next == I64_MAX → no pending handles → break out of the loop.
    { op: "local.get", index: next },
    { op: "i64.const", value: I64_MAX },
    { op: "i64.eq" },
    { op: "br_if", depth: 1 },

    // waitMs = (next - now) / 1e6 ; clamp negative to 0.
    { op: "local.get", index: next },
    { op: "call", funcIdx: state.runLoopNowFuncIdx },
    { op: "i64.sub" },
    { op: "local.set", index: waitMs },
    { op: "local.get", index: waitMs },
    { op: "i64.const", value: 0n },
    { op: "i64.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then:
        sleepMsIdx === undefined
          ? []
          : [
              // ms = (ns + 999_999) / 1_000_000 (round up so we never wake early)
              { op: "local.get", index: waitMs },
              { op: "i64.const", value: 999999n },
              { op: "i64.add" },
              { op: "i64.const", value: 1000000n },
              { op: "i64.div_s" },
              { op: "i32.wrap_i64" },
              { op: "call", funcIdx: sleepMsIdx },
            ],
    },
    // continue looping.
    { op: "br", depth: 0 },
  ];

  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: tickBody,
        },
      ],
    },
  ];
}

/**
 * #2632 Phase 2 — the fd-readiness reactor variant of the run loop. Waits on
 * "fd0-readable OR the nearest timer deadline" (multi-subscription poll) and
 * drains fd0 into the internal stdin buffer each tick, until no timers AND no
 * fd0 subscription remain. Used only when `state.stdinReactor` is set.
 *
 * Each tick:
 *   drain microtasks
 *   now = clock
 *   if fd0 active: set fd0 non-blocking (once); drain available bytes (fd_read);
 *                  a 0-byte read at a readable fd is EOF → drop the subscription
 *   fire due timers (a timer callback may consume the buffered bytes / read more)
 *   drain microtasks
 *   next = peek_deadline
 *   pending = (next != I64_MAX) || fd0 active
 *   if !pending: break
 *   poll_fd0_or_clock(next, now)   ;; block on fd0-readable OR the nearest deadline
 *   loop
 */
function buildRunLoopBodyWithFdReactor(state: AsyncSchedulerState): Instr[] {
  const now = 0;
  const next = 1;
  // $waitMs (2) is unused in the fd-reactor path (poll computes the timeout
  // internally) but kept in the locals list for a stable layout.
  const pending = 3;

  const tickBody: Instr[] = [
    { op: "call", funcIdx: state.drainFuncIdx },
    { op: "call", funcIdx: state.runLoopNowFuncIdx },
    { op: "local.set", index: now },

    // Drain fd0 into the internal stdin buffer if the subscription is live.
    {
      op: "global.get",
      index: state.stdinFdActiveGlobalIdx,
    },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [{ op: "call", funcIdx: state.stdinDrainFuncIdx }, { op: "drop" }],
    },

    // #2632 Phase 3 — invoke the process.stdin Readable pump hook (if any), as
    // LOOP WORK (after the drain, NOT synchronously inside poll_oneoff). The pump
    // moves buffered bytes into the stream and dispatches 'readable'/'data'/'end'
    // callbacks. Skipped (byte-identical to Phase 2) when no reader is registered.
    ...(state.stdinReaderHookGlobalIdx >= 0
      ? ([
          { op: "global.get", index: state.stdinReaderHookGlobalIdx },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" } as any,
            then: [],
            else: [
              // pump(captures=Readable instance, value=null)
              { op: "global.get", index: state.stdinReaderCapGlobalIdx },
              { op: "ref.null.extern" },
              { op: "global.get", index: state.stdinReaderHookGlobalIdx },
              { op: "ref.as_non_null" },
              { op: "call_ref", typeIdx: state.microtaskFuncTypeIdx },
              { op: "drop" },
            ],
          },
        ] satisfies Instr[])
      : []),

    // Fire due timers (callbacks may read the buffered stdin bytes), then drain.
    { op: "local.get", index: now },
    { op: "call", funcIdx: state.timerFireDueFuncIdx },
    { op: "call", funcIdx: state.drainFuncIdx },

    // next = peek
    { op: "call", funcIdx: state.timerPeekDeadlineFuncIdx },
    { op: "local.set", index: next },

    // pending = (next != I64_MAX) | fd0_active
    { op: "local.get", index: next },
    { op: "i64.const", value: I64_MAX },
    { op: "i64.ne" },
    { op: "global.get", index: state.stdinFdActiveGlobalIdx },
    { op: "i32.or" },
    { op: "local.set", index: pending },

    // if !pending → no timers and no fd subscription → exit.
    { op: "local.get", index: pending },
    { op: "i32.eqz" },
    { op: "br_if", depth: 1 },

    // Block on fd0-readable OR the nearest timer deadline. The result (1 if
    // fd0 readable) is dropped; the next iteration's drain reads whatever is
    // ready and fires whichever timer is now due.
    { op: "local.get", index: next },
    { op: "call", funcIdx: state.runLoopNowFuncIdx },
    { op: "call", funcIdx: state.pollFd0OrClockFuncIdx },
    { op: "drop" },

    { op: "br", depth: 0 },
  ];

  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: tickBody,
        },
      ],
    },
  ];
}

// ── #2632 Phase 2 — fd-readiness reactor helper bodies ───────────────────

function buildStdinDrainLocals(): import("../ir/types.js").LocalDef[] {
  return [
    { name: "$errno", type: { kind: "i32" } },
    { name: "$nread", type: { kind: "i32" } },
    { name: "$space", type: { kind: "i32" } },
    { name: "$dst", type: { kind: "i32" } },
  ];
}

/**
 * #2632 Phase 2 — `__rl_stdin_drain() -> i32`.
 *
 * Sets fd 0 non-blocking once (`fd_fdstat_set_flags(0, FDFLAG_NONBLOCK)`), then
 * does a single non-blocking `fd_read` of fd 0 into the internal stdin buffer
 * (RL_STDIN_BUF_START), appending at the write cursor `__stdin_buf_len`.
 * Returns the number of bytes read. A 0-byte read at a *readable* fd is EOF
 * (the reactor only drains after a readiness signal / on the first tick), so a
 * 0-byte read drops the fd0 subscription (`__stdin_fd_active = 0`). EAGAIN
 * (no data yet, errno 6) is treated as "0 bytes this tick" WITHOUT EOF.
 *
 * Buffer management: when the read cursor has consumed the whole buffer
 * (`pos == len`), reset both cursors to 0 to reclaim space before appending.
 */
function buildStdinDrainBody(ctx: CodegenContext, state: AsyncSchedulerState): Instr[] {
  const fdReadIdx = ctx.wasiFdReadIdx;
  const setFlagsIdx = ctx.wasiFdFdstatSetFlagsIdx;
  const errno = 0;
  const nread = 1;
  const space = 2;
  const dst = 3;
  // WASI errno: 6 = EAGAIN (would block — no data available right now).
  const EAGAIN = 6;
  const FDFLAG_NONBLOCK = 0x4;

  if (fdReadIdx === undefined || fdReadIdx < 0) {
    // No fd_read import → nothing to drain; report EOF so the loop can exit.
    return [
      { op: "i32.const", value: 0 },
      { op: "global.set", index: state.stdinFdActiveGlobalIdx },
      { op: "i32.const", value: 0 },
    ];
  }

  return [
    // Set fd0 non-blocking once.
    { op: "global.get", index: state.stdinNonblockSetGlobalIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "i32.const", value: 1 },
        { op: "global.set", index: state.stdinNonblockSetGlobalIdx },
        ...(setFlagsIdx === undefined || setFlagsIdx < 0
          ? []
          : ([
              { op: "i32.const", value: 0 }, // fd 0
              { op: "i32.const", value: FDFLAG_NONBLOCK },
              { op: "call", funcIdx: setFlagsIdx },
              { op: "drop" }, // ignore errno (best-effort)
            ] satisfies Instr[])),
      ],
    },

    // Reclaim space when the buffer is fully consumed: if pos == len, reset both.
    { op: "global.get", index: state.stdinBufPosGlobalIdx },
    { op: "global.get", index: state.stdinBufLenGlobalIdx },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "i32.const", value: 0 },
        { op: "global.set", index: state.stdinBufPosGlobalIdx },
        { op: "i32.const", value: 0 },
        { op: "global.set", index: state.stdinBufLenGlobalIdx },
      ],
    },

    // space = CAP - len ; dst = BUF_START + len.
    { op: "i32.const", value: RL_STDIN_BUF_CAP },
    { op: "global.get", index: state.stdinBufLenGlobalIdx },
    { op: "i32.sub" },
    { op: "local.set", index: space },
    { op: "i32.const", value: RL_STDIN_BUF_START },
    { op: "global.get", index: state.stdinBufLenGlobalIdx },
    { op: "i32.add" },
    { op: "local.set", index: dst },

    // If no space left, report 0 bytes (consumer must drain first).
    { op: "local.get", index: space },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },

    // Build the iovec at RL_FDREAD_IOV_OFFSET: { base=dst, len=space }.
    { op: "i32.const", value: RL_FDREAD_IOV_OFFSET },
    { op: "local.get", index: dst },
    { op: "i32.store", align: 2, offset: 0 },
    { op: "i32.const", value: RL_FDREAD_IOV_OFFSET + 4 },
    { op: "local.get", index: space },
    { op: "i32.store", align: 2, offset: 0 },

    // errno = fd_read(0, iovs=RL_FDREAD_IOV_OFFSET, iovs_len=1, nread=RL_FDREAD_NREAD_OFFSET)
    { op: "i32.const", value: 0 }, // fd 0
    { op: "i32.const", value: RL_FDREAD_IOV_OFFSET },
    { op: "i32.const", value: 1 },
    { op: "i32.const", value: RL_FDREAD_NREAD_OFFSET },
    { op: "call", funcIdx: fdReadIdx },
    { op: "local.set", index: errno },

    // EAGAIN → no data yet, return 0 WITHOUT EOF.
    { op: "local.get", index: errno },
    { op: "i32.const", value: EAGAIN },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },

    // nread = mem[RL_FDREAD_NREAD_OFFSET]
    { op: "i32.const", value: RL_FDREAD_NREAD_OFFSET },
    { op: "i32.load", align: 2, offset: 0 },
    { op: "local.set", index: nread },

    // If errno != 0 (and not EAGAIN), treat as EOF (e.g. EBADF) to avoid spin.
    { op: "local.get", index: errno },
    { op: "i32.const", value: 0 },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "i32.const", value: 0 },
        { op: "global.set", index: state.stdinFdActiveGlobalIdx },
        { op: "i32.const", value: 0 },
        { op: "return" },
      ],
    },

    // nread == 0 at a readable fd → EOF: drop the subscription.
    { op: "local.get", index: nread },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "i32.const", value: 0 },
        { op: "global.set", index: state.stdinFdActiveGlobalIdx },
      ],
      else: [
        // len += nread
        { op: "global.get", index: state.stdinBufLenGlobalIdx },
        { op: "local.get", index: nread },
        { op: "i32.add" },
        { op: "global.set", index: state.stdinBufLenGlobalIdx },
      ],
    },

    { op: "local.get", index: nread },
  ];
}

function buildPollFd0Locals(): import("../ir/types.js").LocalDef[] {
  return [
    { name: "$timeoutNs", type: { kind: "i64" } },
    { name: "$nsubs", type: { kind: "i32" } },
    { name: "$nev", type: { kind: "i32" } },
    { name: "$i", type: { kind: "i32" } },
    { name: "$evType", type: { kind: "i32" } },
    { name: "$readable", type: { kind: "i32" } },
  ];
}

/**
 * #2632 Phase 2 — `__rl_poll_fd0_or_clock(deadlineNs i64, nowNs i64) -> i32`.
 *
 * Builds a multi-subscription `poll_oneoff`:
 *   sub[0] = FD_READ on fd 0 (always, while the loop calls this — fd0 is active)
 *   sub[1] = CLOCK on CLOCK_MONOTONIC with timeout = max(0, deadlineNs - nowNs),
 *            included ONLY when a timer is pending (deadlineNs != I64_MAX).
 * Reads back the event_t array and returns 1 if any event is an FD_READ
 * (type tag 1) → fd0 became readable; else 0 (the clock fired / timeout).
 *
 * `subscription_t` layout (48 bytes), matching `emitWasiSleepMsHelper`:
 *   [0..7]   userdata (u64)
 *   [8]      tag (u8): 0=CLOCK, 1=FD_READ
 *   [16..]   union: FD_READ → fd (u32) @16 ; CLOCK → clockid @16, timeout @24, …
 * `event_t` layout (32 bytes): [0..7] userdata, [8..9] errno (u16),
 *   [10] type (u8): 0=CLOCK, 1=FD_READ, …
 */
function buildPollFd0OrClockBody(ctx: CodegenContext, state: AsyncSchedulerState): Instr[] {
  const pollIdx = ctx.wasiPollOneoffIdx;
  const deadline = 0;
  const nowNs = 1;
  const timeoutNs = 2;
  const nsubs = 3;
  const nev = 4;
  const i = 5;
  const evType = 6;
  const readable = 7;

  if (pollIdx === undefined || pollIdx < 0) {
    // No poll import → cannot wait; report not-readable so the caller loops
    // (the drain on the next tick will detect EOF/no-fd and exit).
    return [{ op: "i32.const", value: 0 }];
  }

  return [
    // ── sub[0] @ RL_POLL_SUB0_OFFSET = FD_READ on fd 0 ──
    // userdata @0 = 0
    { op: "i32.const", value: RL_POLL_SUB0_OFFSET },
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },
    // tag @8 = 1 (EVENTTYPE_FD_READ); pad → store 1 over 8 bytes
    { op: "i32.const", value: RL_POLL_SUB0_OFFSET + 8 },
    { op: "i64.const", value: 1n },
    { op: "i64.store", align: 3, offset: 0 },
    // fd @16 = 0 (and clear the rest of the fd_read union, 32 bytes → 4×i64)
    { op: "i32.const", value: RL_POLL_SUB0_OFFSET + 16 },
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },
    { op: "i32.const", value: RL_POLL_SUB0_OFFSET + 24 },
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },
    { op: "i32.const", value: RL_POLL_SUB0_OFFSET + 32 },
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },
    { op: "i32.const", value: RL_POLL_SUB0_OFFSET + 40 },
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },

    // nsubs = 1 (fd0 only) unless a timer is pending.
    { op: "i32.const", value: 1 },
    { op: "local.set", index: nsubs },

    // If deadline != I64_MAX → add the clock subscription as sub[1].
    { op: "local.get", index: deadline },
    { op: "i64.const", value: I64_MAX },
    { op: "i64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        // timeoutNs = max(0, deadline - now)
        { op: "local.get", index: deadline },
        { op: "local.get", index: nowNs },
        { op: "i64.sub" },
        { op: "local.set", index: timeoutNs },
        { op: "local.get", index: timeoutNs },
        { op: "i64.const", value: 0n },
        { op: "i64.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" } as any,
          then: [
            { op: "i64.const", value: 0n },
            { op: "local.set", index: timeoutNs },
          ],
        },
        // sub[1] @ RL_POLL_SUB1_OFFSET = CLOCK on CLOCK_MONOTONIC.
        // userdata @0 = 0
        { op: "i32.const", value: RL_POLL_SUB1_OFFSET },
        { op: "i64.const", value: 0n },
        { op: "i64.store", align: 3, offset: 0 },
        // tag @8 = 0 (EVENTTYPE_CLOCK), pad → 0
        { op: "i32.const", value: RL_POLL_SUB1_OFFSET + 8 },
        { op: "i64.const", value: 0n },
        { op: "i64.store", align: 3, offset: 0 },
        // clockid @16 = 1 (CLOCK_MONOTONIC), pad @20 = 0 → combined i64
        { op: "i32.const", value: RL_POLL_SUB1_OFFSET + 16 },
        { op: "i64.const", value: 1n },
        { op: "i64.store", align: 3, offset: 0 },
        // timeout @24 = timeoutNs
        { op: "i32.const", value: RL_POLL_SUB1_OFFSET + 24 },
        { op: "local.get", index: timeoutNs },
        { op: "i64.store", align: 3, offset: 0 },
        // precision @32 = 0
        { op: "i32.const", value: RL_POLL_SUB1_OFFSET + 32 },
        { op: "i64.const", value: 0n },
        { op: "i64.store", align: 3, offset: 0 },
        // flags @40 = 0 (relative), pad → clear 8 bytes
        { op: "i32.const", value: RL_POLL_SUB1_OFFSET + 40 },
        { op: "i64.const", value: 0n },
        { op: "i64.store", align: 3, offset: 0 },
        // nsubs = 2
        { op: "i32.const", value: 2 },
        { op: "local.set", index: nsubs },
      ],
    },

    // poll_oneoff(in=SUB0, out=EVT, nsubs, nevents_out=NEVENTS) — errno dropped.
    { op: "i32.const", value: RL_POLL_SUB0_OFFSET },
    { op: "i32.const", value: RL_POLL_EVT_OFFSET },
    { op: "local.get", index: nsubs },
    { op: "i32.const", value: RL_POLL_NEVENTS_OFFSET },
    { op: "call", funcIdx: pollIdx },
    { op: "drop" },

    // nev = mem[RL_POLL_NEVENTS_OFFSET]
    { op: "i32.const", value: RL_POLL_NEVENTS_OFFSET },
    { op: "i32.load", align: 2, offset: 0 },
    { op: "local.set", index: nev },

    // readable = 0 ; scan events for an FD_READ (event_t.type @ +10 == 1).
    { op: "i32.const", value: 0 },
    { op: "local.set", index: readable },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: i },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: i },
            { op: "local.get", index: nev },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },

            // evType = u8 mem[EVT + i*32 + 10]
            { op: "local.get", index: i },
            { op: "i32.const", value: 32 },
            { op: "i32.mul" },
            { op: "i32.const", value: RL_POLL_EVT_OFFSET + 10 },
            { op: "i32.add" },
            { op: "i32.load8_u", align: 0, offset: 0 },
            { op: "local.set", index: evType },

            // if evType == 1 (FD_READ) → readable = 1
            { op: "local.get", index: evType },
            { op: "i32.const", value: 1 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" } as any,
              then: [
                { op: "i32.const", value: 1 },
                { op: "local.set", index: readable },
              ],
            },

            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    { op: "local.get", index: readable },
  ];
}

/**
 * #2632 Phase 2 — emit a `__wasiStdinReadByte()` lowering at a call site.
 * Pushes an i32 onto the caller stack: the next buffered stdin byte (0..255),
 * or -1 when the internal buffer is empty. The reactor (running in `_start`)
 * drains fd0 into the buffer; a timer/microtask callback reads it one byte at a
 * time via this primitive. This is the internal-buffer access path Phase 3's
 * `process.stdin` Readable will build `.read()` on top of.
 */
export function emitStdinReadByte(ctx: CodegenContext, fctx: FunctionContext): void {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  // pos < len ? (byte = mem[BUF_START + pos]; pos++; byte) : -1
  fctx.body.push(
    { op: "global.get", index: state.stdinBufPosGlobalIdx },
    { op: "global.get", index: state.stdinBufLenGlobalIdx },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } } as any,
      then: [
        // byte = mem[BUF_START + pos]
        { op: "i32.const", value: RL_STDIN_BUF_START },
        { op: "global.get", index: state.stdinBufPosGlobalIdx },
        { op: "i32.add" },
        { op: "i32.load8_u", align: 0, offset: 0 },
        // pos++
        { op: "global.get", index: state.stdinBufPosGlobalIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "global.set", index: state.stdinBufPosGlobalIdx },
      ],
      else: [{ op: "i32.const", value: -1 }],
    },
  );
}

/**
 * #2632 Phase 3 — emit `__wasiStdinAvailable()` at a call site. Pushes an i32:
 * the number of bytes currently buffered and unread (`len - pos`). The library
 * `Readable` uses this to decide whether `.read(size)` can satisfy the request.
 */
export function emitStdinAvailable(ctx: CodegenContext, fctx: FunctionContext): void {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  fctx.body.push(
    { op: "global.get", index: state.stdinBufLenGlobalIdx },
    { op: "global.get", index: state.stdinBufPosGlobalIdx },
    { op: "i32.sub" },
  );
}

/**
 * #2632 Phase 3 — emit `__wasiStdinEof()` at a call site. Pushes an i32: 1 when
 * fd0's readable side has hit EOF (the reactor dropped the subscription:
 * `__stdin_fd_active == 0`) AND every buffered byte has been consumed
 * (`pos >= len`); else 0. The library `Readable` uses this to emit `'end'` and
 * to make `.read()` return all-remaining at EOF rather than null-on-short.
 */
export function emitStdinEof(ctx: CodegenContext, fctx: FunctionContext): void {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  // (fd_active == 0) && (pos >= len)
  fctx.body.push(
    { op: "global.get", index: state.stdinFdActiveGlobalIdx },
    { op: "i32.eqz" },
    { op: "global.get", index: state.stdinBufPosGlobalIdx },
    { op: "global.get", index: state.stdinBufLenGlobalIdx },
    { op: "i32.ge_s" },
    { op: "i32.and" },
  );
}

/**
 * #2735 — emit `__wasiStdinStop()` at a call site: a NON-EOF reactor exit
 * trigger. Drops the fd0 subscription by clearing `__stdin_fd_active` (mirrors
 * the EOF clear in `buildStdinDrainBody`), so the run loop's next `pending`
 * test — `(next != I64_MAX) | fd0_active` — falls through and `_start` returns
 * cleanly EVEN THOUGH stdin never reached EOF. Without this the fd-readiness
 * reactor's ONLY termination path is stdin EOF, which hangs the real
 * Native-Messaging case (the peer keeps the pipe open and signals shutdown
 * in-band). Backs `process.stdin.destroy()` and the `process.exit()` pre-exit
 * drop. Stack-neutral; a no-op (and safe to call unconditionally) when the
 * reactor isn't active for this module (the global was never registered).
 */
export function emitStdinStop(ctx: CodegenContext, fctx: FunctionContext): void {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.stdinFdActiveGlobalIdx < 0) return;
  fctx.body.push({ op: "i32.const", value: 0 }, { op: "global.set", index: state.stdinFdActiveGlobalIdx });
}

/**
 * #2735 — true when the fd0 stdin reactor is active for this module (the
 * Phase-2 globals were registered). Lets the WASI `process.exit` lowering
 * decide whether to drop the fd0 subscription before `proc_exit` WITHOUT
 * forcing the reactor onto a program that only calls `process.exit` and never
 * touches stdin.
 */
export function isStdinReactorActive(ctx: CodegenContext): boolean {
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler;
  return !!state && state.stdinReactor && state.stdinFdActiveGlobalIdx >= 0;
}

/**
 * #2632 Phase 3 — emit `__wasiStdinSetReader(cb)` at a call site. Stores the
 * pump funcref + its closure captures into the reactor-tick-hook globals, so the
 * run loop invokes `cb(captures, null)` each tick after draining fd0. The
 * caller pushes the wrapped `$__mt_func_type` funcref (`cbFuncRefInstrs`) and
 * the closure-captures externref (`capInstrs`). Returns nothing.
 */
export function emitStdinSetReader(
  ctx: CodegenContext,
  fctx: FunctionContext,
  cbFuncRefInstrs: Instr[],
  capInstrs: Instr[],
): void {
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler;
  if (!state || state.stdinReaderHookGlobalIdx < 0) {
    throw new Error("emitStdinSetReader called before the stdin reactor registered the hook globals");
  }
  // __stdin_reader_cap = captures
  for (const i of capInstrs) fctx.body.push(i);
  fctx.body.push({ op: "global.set", index: state.stdinReaderCapGlobalIdx });
  // __stdin_reader_hook = (cb as $__mt_func_type)
  for (const i of cbFuncRefInstrs) fctx.body.push(i);
  fctx.body.push({ op: "global.set", index: state.stdinReaderHookGlobalIdx });
}

/**
 * #2632 Phase 2 — mark the stdin reactor active for this module. MUST be called
 * BEFORE `ensureTimerHeap` so the run-loop body is built in the fd-reactor
 * shape and the Phase-2 globals/helpers register. Idempotent.
 */
export function enableStdinReactor(ctx: CodegenContext): void {
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  state.stdinReactor = true;
}

/**
 * #2632 — Emit a `setTimeout`/`setInterval` registration at a call site.
 * Pushes the timer id (i32) onto the caller stack. `cbFuncRefInstrs` push the
 * uniform `$__mt_func_type` funcref; `capInstrs` push the closure-captures
 * externref; `deadlineInstrs` push the absolute deadline (i64 ns);
 * `intervalInstrs` push the re-arm period (i64 ns, 0 = one-shot).
 */
export function emitTimerAdd(
  ctx: CodegenContext,
  fctx: FunctionContext,
  deadlineInstrs: Instr[],
  cbFuncRefInstrs: Instr[],
  capInstrs: Instr[],
  intervalInstrs: Instr[],
): void {
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler;
  if (!state || state.timerAddFuncIdx === -1) {
    throw new Error("emitTimerAdd called before ensureTimerHeap registered __timer_add");
  }
  for (const i of deadlineInstrs) fctx.body.push(i);
  for (const i of cbFuncRefInstrs) fctx.body.push(i);
  for (const i of capInstrs) fctx.body.push(i);
  for (const i of intervalInstrs) fctx.body.push(i);
  fctx.body.push({ op: "call", funcIdx: state.timerAddFuncIdx });
}

/** #2632 — Emit a `clearTimeout`/`clearInterval` at a call site. Consumes the
 *  id already pushed by `idInstrs`. */
export function emitTimerCancel(ctx: CodegenContext, fctx: FunctionContext, idInstrs: Instr[]): void {
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler;
  if (!state || state.timerCancelFuncIdx === -1) {
    throw new Error("emitTimerCancel called before ensureTimerHeap registered __timer_cancel");
  }
  for (const i of idInstrs) fctx.body.push(i);
  fctx.body.push({ op: "call", funcIdx: state.timerCancelFuncIdx });
}

/** #2632 — The monotonic-now reader func idx (`__rl_now_ns() -> i64`), or -1.
 *  Timer call sites read it to compute `deadlineNs = now + ms*1e6`. */
export function getRunLoopNowFuncIdx(ctx: CodegenContext): number {
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler;
  return state ? state.runLoopNowFuncIdx : -1;
}

/**
 * #2632 — Synthesise a uniform `$__mt_func_type` timer-callback wrapper for a
 * user closure. The timer table stores the closure struct itself as the
 * `captures` externref; this wrapper (param 0 = caps externref = the closure
 * struct, param 1 = value externref = unused/null) decodes the struct and
 * invokes the closure via `call_ref` with default args for every parameter
 * (a timer callback receives no arguments in Node — extra `setTimeout` args
 * are out of Phase-1 scope). Returns the wrapper func idx.
 *
 * Mirrors the `.then` wrapper shape (closure call_ref = `[self, ...args,
 * typed_funcref]`) but without promise settlement.
 */
export function emitTimerCallbackWrapper(ctx: CodegenContext, info: ClosureInfo): number {
  ensureTimerHeap(ctx);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  const wrapperId = state.thenWrapperCounter++;
  const wrapperName = `__timer_cb_${wrapperId}`;
  const callbackLocal = 2; // decoded closure struct
  const funcIdx = mintDefinedFunc(ctx);
  const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, info.funcTypeIdx) ?? info.structTypeIdx;

  const locals: LocalDef[] = [{ name: "$callback", type: { kind: "ref", typeIdx: selfTypeIdx } }];
  const body: Instr[] = [
    // caps (param 0) is the closure struct, lifted to externref. Decode it.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: selfTypeIdx },
    { op: "local.set", index: callbackLocal },

    // call_ref shape: [closure_self, ...default_args, typed_funcref]
    { op: "local.get", index: callbackLocal },
  ];
  for (let i = 0; i < info.paramTypes.length; i++) {
    pushDefaultForType(body, info.paramTypes[i]!);
  }
  body.push(
    { op: "local.get", index: callbackLocal },
    { op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 },
    { op: "ref.cast", typeIdx: info.funcTypeIdx },
    { op: "call_ref", typeIdx: info.funcTypeIdx },
  );
  // Discard the closure's return value; coerce to externref result of the
  // wrapper (the run loop drops it). For a non-externref/void return, pop it
  // and push a null externref so the function signature ($__mt_func_type:
  // -> externref) is satisfied.
  coerceStackValueToExternref(ctx, body, info.returnType);

  pushDefinedFunc(ctx, funcIdx, {
    name: wrapperName,
    typeIdx: state.microtaskFuncTypeIdx,
    locals,
    body,
    exported: false,
  });
  ctx.funcMap.set(wrapperName, funcIdx);
  return funcIdx;
}

/**
 * #2632 — Run-loop hook for WASI `_start`. Returns the funcIdx of
 * `__run_event_loop` when the timer heap was registered (the loop supersedes
 * the one-shot drain — it drains microtasks itself), else `null` so the caller
 * falls back to the bare drain.
 */
export function getRunLoopFuncIdxForWasiStart(ctx: CodegenContext): number | null {
  const state = (ctx as CodegenContextWithScheduler).asyncScheduler;
  if (!state || !state.timerHeapRegistered || state.runLoopFuncIdx === -1) return null;
  return state.runLoopFuncIdx;
}

/**
 * #1326 Phase 1B — emit standalone-mode `Promise.resolve(value)` as a
 * Wasm-native `$Promise` GC struct construction. The caller has
 * already pushed `value` (as externref) onto the Wasm stack via
 * `valueInstrs`; this helper appends:
 *   - i32.const 1                  (state = FULFILLED)
 *   - <valueInstrs>                (value = caller's pushed externref)
 *   - ref.null extern              (callbacks placeholder — Phase 1C-B
 *                                   will upgrade to a typed pending list)
 *   - struct.new $Promise          (consumes 3 stack values)
 *   - extern.convert_any           (lift (ref $Promise) → externref so
 *                                   downstream consumers keep working)
 *
 * The return is on the Wasm stack as `externref`. Internal helpers
 * (`Promise.then`, `Promise.all`, etc.) `ref.cast` it back to
 * `(ref $Promise)` to read the state/value/callbacks fields.
 */
export function emitStandalonePromiseResolve(ctx: CodegenContext, fctx: FunctionContext, valueInstrs: Instr[]): void {
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  // (#3125) `Promise.resolve(x)` is spec PromiseResolve(C, x) §27.2.4.7:
  //   - x already a (native) promise → return x UNCHANGED (step 2);
  //   - otherwise NewPromiseCapability + Resolve(p, x) — which assimilates
  //     user thenables / rejects on a poisoned `then` via
  //     `__promise_resolve_value`, instead of the old direct
  //     FULFILLED-with-x struct mint (which handed thenables to handlers raw).
  // Plain values still settle synchronously through the fulfil fast path, so
  // non-thenable behaviour is observably unchanged.
  ensurePromiseSettleFunctions(ctx);
  const resolveValueIdx = ctx.funcMap.get("__promise_resolve_value");
  if (resolveValueIdx === undefined) {
    // Defensive legacy fallback: direct fulfilled mint (pre-#3125 shape).
    fctx.body.push({ op: "i32.const", value: PROMISE_STATE_FULFILLED });
    for (const instr of valueInstrs) fctx.body.push(instr);
    fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
    fctx.body.push({ op: "extern.convert_any" });
    return;
  }
  const vLocal = allocLocal(fctx, `__presolve_v_${fctx.locals.length}`, { kind: "externref" });
  const pLocal = allocLocal(fctx, `__presolve_p_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: promiseTypeIdx,
  });
  for (const instr of valueInstrs) fctx.body.push(instr);
  fctx.body.push({ op: "local.set", index: vLocal });
  fctx.body.push({ op: "local.get", index: vLocal });
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.test", typeIdx: promiseTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: [
      // Already a native promise: pass through unchanged.
      { op: "local.get", index: vLocal },
    ],
    else: [
      // p = pending $Promise; Resolve(p, v); result p.
      { op: "i32.const", value: PROMISE_STATE_PENDING },
      { op: "ref.null.extern" },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: promiseTypeIdx },
      { op: "local.set", index: pLocal },
      { op: "local.get", index: pLocal },
      { op: "local.get", index: vLocal },
      { op: "call", funcIdx: resolveValueIdx },
      { op: "drop" },
      { op: "local.get", index: pLocal },
      { op: "extern.convert_any" },
    ],
  });
}

/**
 * #1326 Phase 1B — emit standalone-mode `Promise.reject(reason)` as a
 * Wasm-native `$Promise` GC struct construction. Symmetric to
 * `emitStandalonePromiseResolve` but with `state = REJECTED`.
 */
export function emitStandalonePromiseReject(ctx: CodegenContext, fctx: FunctionContext, reasonInstrs: Instr[]): void {
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  // (#2958) Ensure the unhandled-rejection substrate exists (a wasi-gated no-op
  // otherwise). `Promise.reject(x)` mints a REJECTED `$Promise` DIRECTLY, so it
  // never passes through `__promise_reject`'s settle body — record it here.
  ensureUnhandledRejectionTracking(ctx);
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_REJECTED });
  for (const instr of reasonInstrs) fctx.body.push(instr);
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  if (state.unhandledHeadGlobalIdx >= 0) {
    const pLocal = allocLocal(fctx, `__preject_p_${fctx.locals.length}`, { kind: "ref", typeIdx: promiseTypeIdx });
    fctx.body.push({ op: "local.set", index: pLocal });
    for (const instr of buildNoteUnhandledRejection(state, [{ op: "local.get", index: pLocal }])) {
      fctx.body.push(instr);
    }
    fctx.body.push({ op: "local.get", index: pLocal });
  }
  fctx.body.push({ op: "extern.convert_any" });
}

export interface StandalonePromiseThenCallback {
  instrs: Instr[];
  /**
   * Statically-resolved handler closure. Absent for a DYNAMIC handler (#4394):
   * a runtime-held function value (`p.then(onResFulfilled, onResRejected)` on
   * captured resolvers, `p.then($DONE)` on a reassigned global) whose shape the
   * compiler cannot see. Dynamic handlers ride `instrs` as a plain externref
   * and are invoked at settle time by the shared `__then_dyn_*` wrapper via
   * `__apply_closure`. Before #4394 these were silently treated as ABSENT
   * (identity/pass-through), which left every promise chained through such a
   * handler pending forever — the asyncHelpers `resSettlementP` stall.
   */
  closureInfo?: ClosureInfo;
  /** Marks the dynamic-handler case above. */
  dynamic?: boolean;
}

/**
 * #1326 Phase 1C-B — emit standalone-mode `promise.then(onFulfilled,
 * onRejected?)`.
 *
 * The emitted code constructs a new pending chained `$Promise`, captures the
 * user closure (if callable) plus that chained promise in `$__then_caps`, then:
 *   - already-fulfilled receiver: enqueue fulfillment wrapper immediately
 *   - already-rejected receiver: enqueue rejection wrapper immediately
 *   - pending receiver: prepend a `$PromiseCallback` node to receiver.callbacks
 *
 * Drain-time wrappers invoke the closure through WasmGC `call_ref`, settle the
 * chained promise, and enqueue any callbacks that were attached to the chained
 * promise while it was pending. Missing/non-callable handlers use identity
 * fulfill / pass-through reject wrappers.
 */
export function emitStandalonePromiseThen(
  ctx: CodegenContext,
  fctx: FunctionContext,
  promiseInstrs: Instr[],
  onFulfilled: StandalonePromiseThenCallback | null,
  onRejected?: StandalonePromiseThenCallback | null,
): void {
  ensurePromiseSettleFunctions(ctx);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const callbackTypeIdx = getOrRegisterPromiseCallbackType(ctx);
  const capsTypeIdx = getOrRegisterThenCapsType(ctx);

  // (#2867 Gap 1) handler results settle the chained promise via resolve-value
  // (not fulfill) so a handler that RETURNS a promise/thenable causes the chain
  // to adopt that inner promise's eventual state. A reject handler that returns
  // normally also fulfils the chain (catch-recovery), so it routes the same way.
  // (#4394) A DYNAMIC handler (no ClosureInfo — a runtime-held function value)
  // takes the shared `__then_dyn_*` wrapper, which invokes it at settle time via
  // `__apply_closure`. Falls back to the identity wrapper (the pre-#4394
  // treated-as-absent behaviour) only if the dynamic machinery is unavailable.
  const fulfillWrapperFuncIdx = onFulfilled
    ? onFulfilled.closureInfo
      ? emitThenWrapperFunction(ctx, onFulfilled.closureInfo, state.promiseResolveValueFuncIdx, "__then_fulfill")
      : (ensureDynamicThenWrapper(ctx, "fulfill") ?? state.identityFulfillWrapperFuncIdx)
    : state.identityFulfillWrapperFuncIdx;
  const rejectWrapperFuncIdx = onRejected
    ? onRejected.closureInfo
      ? emitThenWrapperFunction(ctx, onRejected.closureInfo, state.promiseResolveValueFuncIdx, "__then_reject")
      : (ensureDynamicThenWrapper(ctx, "reject") ?? state.identityRejectWrapperFuncIdx)
    : state.identityRejectWrapperFuncIdx;

  const promiseLocal = allocLocal(fctx, `__then_promise_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: promiseTypeIdx,
  });
  const chainedLocal = allocLocal(fctx, `__then_chained_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: promiseTypeIdx,
  });
  const fulfilledCapsLocal = allocLocal(fctx, `__then_fulfilled_caps_${fctx.locals.length}`, {
    kind: "externref",
  });
  const rejectedCapsLocal = allocLocal(fctx, `__then_rejected_caps_${fctx.locals.length}`, {
    kind: "externref",
  });

  for (const instr of promiseInstrs) fctx.body.push(instr);
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "local.set", index: promiseLocal });

  // Chained promise starts pending with no callbacks.
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "local.set", index: chainedLocal });

  if (onFulfilled) {
    for (const instr of onFulfilled.instrs) fctx.body.push(instr);
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "local.get", index: chainedLocal });
  fctx.body.push({ op: "struct.new", typeIdx: capsTypeIdx });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.set", index: fulfilledCapsLocal });

  if (onRejected) {
    for (const instr of onRejected.instrs) fctx.body.push(instr);
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
  fctx.body.push({ op: "local.get", index: chainedLocal });
  fctx.body.push({ op: "struct.new", typeIdx: capsTypeIdx });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.set", index: rejectedCapsLocal });

  fctx.body.push(
    { op: "local.get", index: promiseLocal },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: PROMISE_STATE_FULFILLED },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "ref.func", funcIdx: fulfillWrapperFuncIdx },
        { op: "local.get", index: fulfilledCapsLocal },
        { op: "local.get", index: promiseLocal },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
        { op: "call", funcIdx: state.enqueueFuncIdx },
      ],
      else: [
        { op: "local.get", index: promiseLocal },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: PROMISE_STATE_REJECTED },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // (#2958) A reaction attached to an ALREADY-REJECTED promise means it
            // is now handled: clear its unhandled-list flag so the exit-time
            // reporter skips it (satisfies "adding `.catch` silences it" and
            // same-turn late-attach). No-op when tracking is inactive.
            ...(state.markRejectionHandledFuncIdx >= 0
              ? ([
                  { op: "local.get", index: promiseLocal },
                  { op: "call", funcIdx: state.markRejectionHandledFuncIdx },
                ] satisfies Instr[])
              : []),
            { op: "ref.func", funcIdx: rejectWrapperFuncIdx },
            { op: "local.get", index: rejectedCapsLocal },
            { op: "local.get", index: promiseLocal },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
            { op: "call", funcIdx: state.enqueueFuncIdx },
          ],
          else: [
            // Pending receiver: push a callback node in front of the current
            // callback list. This preserves every continuation needed for
            // chaining. FIFO append can be added later without changing the
            // node shape; simple chains have one pending callback per promise.
            { op: "local.get", index: promiseLocal },
            { op: "ref.func", funcIdx: fulfillWrapperFuncIdx },
            { op: "local.get", index: fulfilledCapsLocal },
            { op: "ref.func", funcIdx: rejectWrapperFuncIdx },
            { op: "local.get", index: rejectedCapsLocal },
            { op: "local.get", index: promiseLocal },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 2 },
            { op: "struct.new", typeIdx: callbackTypeIdx },
            { op: "extern.convert_any" },
            { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 2 },
          ],
        },
      ],
    },
    { op: "local.get", index: chainedLocal },
    { op: "extern.convert_any" },
  );
}

// ─── (#2903) native `Promise.prototype.finally` (§27.2.5.3) ─────────────────
//
// `p.finally(onFinally)` lowers onto the existing native then machinery with
// TWO dedicated reaction wrappers instead of the `.then` handler wrappers:
//
//   thenFinally(value):  r = onFinally();  PromiseResolve(r) → then settle the
//                        chained promise with the ORIGINAL value (resolve-value,
//                        so a promise-valued original still assimilates);
//   catchFinally(reason): r = onFinally(); PromiseResolve(r) → then REJECT the
//                        chained promise with the ORIGINAL reason (thrower).
//
// In both arms `onFinally` is invoked with ZERO arguments, its return value is
// observable only through PromiseResolve (a rejected/throwing result OVERRIDES
// the settlement with its own reason — §27.2.5.3 steps 5-7), and a plain
// return preserves the original settlement (value identity included — the
// value rides an externref field, never a host roundtrip). Non-callable /
// absent `onFinally` degrades to the identity pass-through chain, exactly
// `then(onFinally, onFinally)` with non-callable handlers (§27.2.5.3 step 3).
//
// The "wait for onFinally's result" step reuses `__promise_resolve_value` on a
// throwaway pending `$Promise` (`tmp`) whose reaction node is pre-attached:
// settling tmp (directly for a plain result, after adoption for a promise/
// thenable result) fires `__finally_restore_settle` / `__finally_restore_reject`
// as microtasks, which then settle the chained promise. This composes the
// substrate exactly like the combinators do — no forked scheduling machinery.

/**
 * Idempotently register the module-level finally runtime: the restore-caps
 * struct and the three shared helpers. Standalone/wasi only (callers are gated
 * on `isStandaloneThenChainNativeActive`); never touches gc/host output.
 */
function ensurePromiseFinallyRuntime(ctx: CodegenContext): void {
  ensurePromiseSettleFunctions(ctx);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.finallyAfterFuncIdx !== -1) return;

  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const callbackTypeIdx = getOrRegisterPromiseCallbackType(ctx);

  // $__finally_restore_caps { chained (ref $Promise), value externref, isReject i32 }
  const capsName = "$__finally_restore_caps";
  const capsFields = [
    { name: "chained", type: { kind: "ref", typeIdx: promiseTypeIdx } as ValType, mutable: false },
    { name: "value", type: { kind: "externref" } as ValType, mutable: false },
    { name: "isReject", type: { kind: "i32" } as ValType, mutable: false },
  ];
  const capsTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: capsName, fields: capsFields });
  ctx.structMap.set(capsName, capsTypeIdx);
  ctx.typeIdxToStructName.set(capsTypeIdx, capsName);
  ctx.structFields.set(
    capsName,
    capsFields.map((f) => ({ name: f.name, type: f.type, mutable: f.mutable })),
  );
  state.finallyRestoreCapsTypeIdx = capsTypeIdx;

  const restoreSettleFuncIdx = mintDefinedFunc(ctx);
  const restoreRejectFuncIdx = mintDefinedFunc(ctx);
  const afterFuncIdx = mintDefinedFunc(ctx);
  state.finallyRestoreSettleFuncIdx = restoreSettleFuncIdx;
  state.finallyRestoreRejectFuncIdx = restoreRejectFuncIdx;
  state.finallyAfterFuncIdx = afterFuncIdx;

  // __finally_restore_settle(caps, _ignored) — onFinally's result settled OK:
  // re-settle `chained` with the ORIGINAL outcome. Fulfil path routes through
  // resolve-value (a promise-valued original assimilates, mirroring the spec
  // valueThunk → then-resolution); reject path is a direct reject (rejection
  // reasons are never assimilated).
  pushDefinedFunc(ctx, restoreSettleFuncIdx, {
    name: "__finally_restore_settle",
    typeIdx: state.microtaskFuncTypeIdx,
    locals: [{ name: "$caps", type: { kind: "ref", typeIdx: capsTypeIdx } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: capsTypeIdx },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 2 },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 0 },
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
          { op: "call", funcIdx: state.promiseRejectFuncIdx },
        ],
        else: [
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 0 },
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
          { op: "call", funcIdx: state.promiseResolveValueFuncIdx },
        ],
      },
    ],
    exported: false,
  });
  ctx.funcMap.set("__finally_restore_settle", restoreSettleFuncIdx);

  // __finally_restore_reject(caps, reason) — onFinally's result REJECTED (or a
  // thenable it returned rejected): the chained promise rejects with THAT
  // reason, overriding the original settlement (§27.2.5.3 — a throwing/
  // rejecting onFinally wins).
  pushDefinedFunc(ctx, restoreRejectFuncIdx, {
    name: "__finally_restore_reject",
    typeIdx: state.microtaskFuncTypeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: capsTypeIdx },
      { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: state.promiseRejectFuncIdx },
    ],
    exported: false,
  });
  ctx.funcMap.set("__finally_restore_reject", restoreRejectFuncIdx);

  // __finally_after(result, chained, value, isReject) — the spec
  // "p2 = PromiseResolve(C, onFinally()); p2.then(restore)" step: build a
  // throwaway pending promise with the restore reaction PRE-attached, then
  // resolve it with `result` (direct fulfil for plain values, adoption for a
  // `$Promise`, PromiseResolveThenableJob for user thenables — all via
  // `__promise_resolve_value`). The pre-attach keeps the reaction ordering a
  // microtask behind the result settling, matching the `.then` hop.
  const afterTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "ref", typeIdx: promiseTypeIdx }, { kind: "externref" }, { kind: "i32" }],
    [],
    "$__finally_after_type",
  );
  pushDefinedFunc(ctx, afterFuncIdx, {
    name: "__finally_after",
    typeIdx: afterTypeIdx,
    locals: [
      { name: "$caps", type: { kind: "externref" } },
      { name: "$tmp", type: { kind: "ref", typeIdx: promiseTypeIdx } },
    ],
    body: [
      // caps = $__finally_restore_caps{chained, value, isReject}
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "struct.new", typeIdx: capsTypeIdx },
      { op: "extern.convert_any" },
      { op: "local.set", index: 4 },
      // tmp = $Promise{PENDING, null, node(restoreSettle, caps, restoreReject, caps, null)}
      { op: "i32.const", value: PROMISE_STATE_PENDING },
      { op: "ref.null.extern" },
      { op: "ref.func", funcIdx: restoreSettleFuncIdx },
      { op: "local.get", index: 4 },
      { op: "ref.func", funcIdx: restoreRejectFuncIdx },
      { op: "local.get", index: 4 },
      { op: "ref.null.extern" },
      { op: "struct.new", typeIdx: callbackTypeIdx },
      { op: "extern.convert_any" },
      { op: "struct.new", typeIdx: promiseTypeIdx },
      { op: "local.set", index: 5 },
      // Resolve(tmp, result) — fires/enqueues the restore reaction.
      { op: "local.get", index: 5 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: state.promiseResolveValueFuncIdx },
      { op: "drop" },
    ],
    exported: false,
  });
  ctx.funcMap.set("__finally_after", afterFuncIdx);
}

/**
 * Emit one per-site finally reaction wrapper (microtask signature). Invokes the
 * user `onFinally` closure with ZERO user arguments inside a try/catch (a throw
 * rejects the chained promise immediately — no restore step), then hands its
 * result to `__finally_after` together with the original settlement.
 */
function emitFinallyWrapperFunction(ctx: CodegenContext, info: ClosureInfo, isReject: boolean): number {
  ensurePromiseFinallyRuntime(ctx);
  ensureUnionHelpersForThenWrapper(ctx, info);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  const capsTypeIdx = getOrRegisterThenCapsType(ctx);
  const wrapperId = state.thenWrapperCounter++;
  const wrapperName = `__finally_${isReject ? "reject" : "fulfill"}_${wrapperId}`;
  const capLocal = 2;
  const callbackLocal = 3;
  const resultLocal = 4;
  const reasonLocal = 5;
  const funcIdx = mintDefinedFunc(ctx);
  const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, info.funcTypeIdx) ?? info.structTypeIdx;

  const locals: LocalDef[] = [
    { name: "$caps", type: { kind: "ref", typeIdx: capsTypeIdx } },
    { name: "$callback", type: { kind: "ref", typeIdx: selfTypeIdx } },
    { name: "$result", type: { kind: "externref" } },
    { name: "$reason", type: { kind: "externref" } },
  ];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: capsTypeIdx },
    { op: "local.set", index: capLocal },
    { op: "local.get", index: capLocal },
    { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: selfTypeIdx },
    { op: "local.set", index: callbackLocal },
  ];

  const exnTag = ensureExnTag(ctx);
  const tryBody: Instr[] = [{ op: "local.get", index: callbackLocal }];
  // §27.2.5.3: onFinally is called with NO arguments — every declared param
  // gets its type default (undefined/zero), never the settlement value.
  for (const paramType of info.paramTypes) pushDefaultForType(tryBody, paramType);
  tryBody.push(
    { op: "local.get", index: callbackLocal },
    { op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 },
    { op: "ref.cast", typeIdx: info.funcTypeIdx },
    { op: "call_ref", typeIdx: info.funcTypeIdx },
  );
  coerceStackValueToExternref(ctx, tryBody, info.returnType);
  tryBody.push(
    { op: "local.set", index: resultLocal },
    // __finally_after(result, chained, originalValue, isReject)
    { op: "local.get", index: resultLocal },
    { op: "local.get", index: capLocal },
    { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: 1 },
    { op: "i32.const", value: isReject ? 1 : 0 },
    { op: "call", funcIdx: state.finallyAfterFuncIdx },
  );

  body.push(
    buildTargetTaggedTry(ctx, { kind: "empty" }, tryBody, [
      {
        tagIdx: exnTag,
        body: [
          { op: "local.set", index: reasonLocal },
          { op: "local.get", index: capLocal },
          { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: reasonLocal },
          { op: "call", funcIdx: state.promiseRejectFuncIdx },
          { op: "drop" },
        ],
      },
    ]),
  );
  body.push({ op: "ref.null.extern" });

  pushDefinedFunc(ctx, funcIdx, {
    name: wrapperName,
    typeIdx: state.microtaskFuncTypeIdx,
    locals,
    body,
    exported: false,
  });
  ctx.funcMap.set(wrapperName, funcIdx);
  return funcIdx;
}

/**
 * (#2903) Emit standalone-mode `promise.finally(onFinally)` on the native
 * `$Promise` then machinery. Consumes `promiseInstrs` (an externref that MUST
 * be a `$Promise` — callers bridge/refuse non-natives) and leaves the chained
 * promise as externref on the stack. A null `onFinally` (absent / non-callable
 * / nullish argument) degrades to the identity pass-through chain
 * (`then(onFinally, onFinally)` with non-callable handlers, §27.2.5.3 step 3).
 */
export function emitStandalonePromiseFinally(
  ctx: CodegenContext,
  fctx: FunctionContext,
  promiseInstrs: Instr[],
  onFinally: StandalonePromiseThenCallback | null,
): void {
  // (#4394) `.finally` has no dynamic-handler wrapper yet — a dynamic marker
  // (no ClosureInfo) degrades to the absent-handler identity chain, exactly the
  // pre-#4394 behaviour for a handler the compiler could not resolve.
  if (onFinally === null || onFinally.closureInfo === undefined) {
    emitStandalonePromiseThen(ctx, fctx, promiseInstrs, null, null);
    return;
  }
  ensurePromiseSettleFunctions(ctx);
  ensurePromiseFinallyRuntime(ctx);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const callbackTypeIdx = getOrRegisterPromiseCallbackType(ctx);
  const capsTypeIdx = getOrRegisterThenCapsType(ctx);

  // Register the per-site wrappers BEFORE any body emission (funcIdx bake
  // discipline — #1677/#1809).
  const fulfillWrapperFuncIdx = emitFinallyWrapperFunction(ctx, onFinally.closureInfo, false);
  const rejectWrapperFuncIdx = emitFinallyWrapperFunction(ctx, onFinally.closureInfo, true);

  const promiseLocal = allocLocal(fctx, `__finally_promise_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: promiseTypeIdx,
  });
  const chainedLocal = allocLocal(fctx, `__finally_chained_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: promiseTypeIdx,
  });
  const capsLocal = allocLocal(fctx, `__finally_caps_${fctx.locals.length}`, { kind: "externref" });

  for (const instr of promiseInstrs) fctx.body.push(instr);
  fctx.body.push({ op: "any.convert_extern" });
  fctx.body.push({ op: "ref.cast", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "local.set", index: promiseLocal });

  // Chained promise starts pending with no callbacks.
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_PENDING });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "local.set", index: chainedLocal });

  // ONE caps struct serves both arms (both wrappers read the same closure +
  // chained promise). The closure instrs are spliced exactly ONCE — aliasing
  // one Instr[] into two branches double-bumps under the late-import shifter
  // (see reference_shared_instr_object_dce_double_remap).
  for (const instr of onFinally.instrs) fctx.body.push(instr);
  fctx.body.push({ op: "local.get", index: chainedLocal });
  fctx.body.push({ op: "struct.new", typeIdx: capsTypeIdx });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.set", index: capsLocal });

  fctx.body.push(
    { op: "local.get", index: promiseLocal },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: PROMISE_STATE_FULFILLED },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "ref.func", funcIdx: fulfillWrapperFuncIdx },
        { op: "local.get", index: capsLocal },
        { op: "local.get", index: promiseLocal },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
        { op: "call", funcIdx: state.enqueueFuncIdx },
      ],
      else: [
        { op: "local.get", index: promiseLocal },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: PROMISE_STATE_REJECTED },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // (#2958) `.finally` on an already-rejected promise attaches a
            // reaction → the rejection is now handled; clear its unhandled flag.
            ...(state.markRejectionHandledFuncIdx >= 0
              ? ([
                  { op: "local.get", index: promiseLocal },
                  { op: "call", funcIdx: state.markRejectionHandledFuncIdx },
                ] satisfies Instr[])
              : []),
            { op: "ref.func", funcIdx: rejectWrapperFuncIdx },
            { op: "local.get", index: capsLocal },
            { op: "local.get", index: promiseLocal },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
            { op: "call", funcIdx: state.enqueueFuncIdx },
          ],
          else: [
            // Pending receiver: prepend a reaction node (same discipline as
            // emitStandalonePromiseThen).
            { op: "local.get", index: promiseLocal },
            { op: "ref.func", funcIdx: fulfillWrapperFuncIdx },
            { op: "local.get", index: capsLocal },
            { op: "ref.func", funcIdx: rejectWrapperFuncIdx },
            { op: "local.get", index: capsLocal },
            { op: "local.get", index: promiseLocal },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 2 },
            { op: "struct.new", typeIdx: callbackTypeIdx },
            { op: "extern.convert_any" },
            { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 2 },
          ],
        },
      ],
    },
    { op: "local.get", index: chainedLocal },
    { op: "extern.convert_any" },
  );
}

/**
 * #1326/#4397 — Check whether native Promise codegen (`$Promise` carrier:
 * construction, async-fn return wrap, `await` unwrap) is active. Native-first
 * JS builds use the same carrier and add only explicit boundary adapters.
 *
 * **THE #2980 CARRIER WIDEN IS FLIPPED (2026-07-10, stakeholder-approved):**
 * `--target standalone` now takes the native `$Promise` lane too, except for
 * modules containing an async generator ({@link widenAsyncGenFallback} keeps
 * their whole promise pipeline host-consistent). This is exactly the semantics
 * the ratified rule-1 decision measure validated (plan/issues/2980):
 * 07-09 full A/B net **+18** with the fallback (async-generator bucket
 * −4→+0), 07-10 six-bucket confirmation net **+20** with NO bucket ≤ −2
 * (class-async supplement included). The pairing constraint (#2978/#2934-3b,
 * PR #2833) landed 2026-07-10 before this flip, per the tradeoff doc
 * (plan/log/2980-carrier-widen-tradeoff.md §6.4).
 *
 * History (why this was wasi-only for so long): AG0 (#2865) widened
 * prematurely and measured **−31** — the `flags:[async]` harness settles
 * synchronously, so a native `$Promise` result was an undrained struct. The
 * PATH-B drive layers (#2895/#2906 slices, #2483 host-drive, #3035 `.then`
 * receiver bridge, #2979 value carrier) landed since; the 07-02 measure was
 * still −51, and the residual classes were then fixed one by one (#3035,
 * #2906 3d-i/ii/iii, the async-gen fallback) until the sign flipped. Both
 * carrier gates flip TOGETHER (the AG0-safe coupling — no per-construct
 * gating; see #2980 rule 2).
 */
export function isStandalonePromiseActive(ctx: CodegenContext): boolean {
  return (
    ctx.targetProfile.semanticProviders === "native-first" ||
    ctx.wasi === true ||
    (ctx.standalone === true && !widenAsyncGenFallback(ctx))
  );
}

/**
 * (#2980 conservative Promise-lane fallback, #3132 PR-2 refinement) Keep BOTH
 * standalone carrier gates OFF for a module that WILL emit a legacy `__gen_*`
 * host buffer — there a native `$Promise` fed into the gen's legacy buffer /
 * host `.then` over `__gen_next` is mishandled (the 07-09 async-generator −4).
 *
 * #2980 keyed this on `moduleHasAsyncGen` (ANY async gen ⇒ carrier off) — safe
 * but blunt: it also blocked modules whose async gens ALL drive host-free, which
 * have NO legacy buffer to mix into. #3132 PR-2 refines it to
 * `moduleHasNonDrivableAsyncGen` — off ONLY when at least one async gen falls to
 * the legacy buffer (method / unbounded body / rest param / unsafe spill / stem
 * collision). An all-drivable module keeps the carrier ON, so its driven gens
 * settle through the native `$Promise` and lose their `env::Promise_*` /
 * `__get_caught_exception` imports (host-free floor). The verdict is computed
 * pre-body in `collectDeclarations` with the SAME drive-shape predicate the emit
 * gate uses (`asyncGenDrivableUnderCarrier`), so a module judged all-drivable
 * never falls a gen to the buffer at emit — no mixing. CONSERVATIVE: any doubt
 * ⇒ non-drivable ⇒ carrier off (pre-#2980 host-consistent behaviour). WASI
 * (carrier always on) + gc/host unaffected (standalone-only check).
 */
function widenAsyncGenFallback(ctx: CodegenContext): boolean {
  return ctx.moduleHasNonDrivableAsyncGen === true;
}

// (#2980) The `JS2WASM_ASYNC_CARRIER_WIDEN` measurement instrument is RETIRED
// with the flip (2026-07-10): the measured on-arm IS now the production
// behaviour of both carrier gates, so the env toggle would be a no-op. The
// recorded A/B protocol + harness stay in `scripts/measure/` and
// plan/issues/2980 for any future re-measure need.

/**
 * (#2895/#2980) Gate for the **native `.then` / `.catch` chaining** lowering
 * (`emitStandalonePromiseThen`) — flipped WITH {@link isStandalonePromiseActive}
 * (the AG0-safe coupling; #2980 rule 2: one gate, one flip, one measure).
 *
 * Widen safety, measured: the historical −601 stack-imbalance hazard of this
 * lowering on `--target standalone` is retired by #3035's runtime `ref.test`
 * receiver bridge (non-native receivers keep the exact host `.then` path) —
 * the promise-then-all bucket measured **+12** under the widen (07-10
 * confirmation A/B), with zero invalid-Wasm anywhere in the 322-file sample.
 *
 * Async-generator modules take {@link widenAsyncGenFallback} to the HOST lane
 * entirely — including the former #2865 receiver-directed arm
 * (`getDrainFuncIdxForWasiStart(ctx) !== null`), which this widened predicate
 * subsumes for every other standalone module (the widen is a superset of
 * "driven machinery registered"). That exact semantics — bridge off for
 * async-gen modules, on for everything else — is what the rule-1 measure
 * validated (async-generator bucket net 0, zero regressions).
 */
export function isStandaloneThenChainNativeActive(ctx: CodegenContext): boolean {
  return (
    ctx.targetProfile.semanticProviders === "native-first" ||
    ctx.wasi === true ||
    (ctx.standalone === true && !widenAsyncGenFallback(ctx))
  );
}

/**
 * All `*FuncIdx` side-channel fields on `ctx.asyncScheduler` that hold a
 * **defined-function** index (never an import). These are read directly at
 * call-bake sites (`emitStandalonePromiseThen`, the microtask/timer emitters,
 * `emitThenWrapperFunction`'s `settleFuncIdx`, …), so any late-import addition
 * must shift them in lockstep with the defined-function body walk — exactly the
 * lockstep `nativeStrHelpers` / `mapHelpers` / `pendingMethodTrampolines` get.
 *
 * The list MUST stay complete: a missing key (historically
 * `promiseResolveValueFuncIdx`, #2867 Gap 1) leaves a `.then` handler wrapper
 * calling one function too EARLY after a late import lands between the settle
 * helpers' registration and a downstream bake site — an arity mismatch that
 * surfaces as "not enough arguments on the stack for call" invalid Wasm (the
 * −601 standalone-scale Promise.then/all regression, #2918). See
 * {@link shiftAsyncSideChannelFuncIdxs}.
 */
const ASYNC_SCHEDULER_FUNC_IDX_KEYS = [
  "enqueueFuncIdx",
  "drainFuncIdx",
  "growFuncIdx",
  "promiseFulfillFuncIdx",
  "promiseRejectFuncIdx",
  "identityFulfillWrapperFuncIdx",
  "identityRejectWrapperFuncIdx",
  "promiseResolveValueFuncIdx",
  // (#2903) native `.finally` runtime — `emitStandalonePromiseFinally` /
  // `emitFinallyWrapperFunction` bake `ref.func`/`call` from these.
  "finallyRestoreSettleFuncIdx",
  "finallyRestoreRejectFuncIdx",
  "finallyAfterFuncIdx",
  "timerAddFuncIdx",
  "timerCancelFuncIdx",
  "timerPeekDeadlineFuncIdx",
  "timerFireDueFuncIdx",
  "runLoopFuncIdx",
  "runLoopNowFuncIdx",
  "stdinDrainFuncIdx",
  "pollFd0OrClockFuncIdx",
] as const;

/**
 * Combinator (`Promise.all`/`race`) runtime `*FuncIdx` fields on
 * `ctx.__promiseCombinators` (see promise-combinators.ts `CombinatorRuntime`).
 * Same lockstep requirement as the scheduler keys — the aggregator call site
 * (`emitStandalonePromiseCombinator`) bakes `ref.func`/`call` straight from these.
 */
const COMBINATOR_FUNC_IDX_KEYS = [
  "subscribeFuncIdx",
  "allFulfillFuncIdx",
  "raceFulfillFuncIdx",
  "rejectFuncIdx",
  // (#3137) allSettled/any wrappers — lazily minted (undefined on all/race-only
  // modules; the shifter's typeof-number guard skips them).
  "allSettledFulfillFuncIdx",
  "allSettledRejectFuncIdx",
  "anyRejectFuncIdx",
  "aggErrNewFuncIdx",
] as const;

/**
 * Shift every async-substrate side-channel funcIdx (scheduler + Promise.all/race
 * combinators) up by `added` when it points at or past `importsBefore`. Called
 * from ALL THREE late-import shifters (`shiftLateImportIndices`,
 * `addStringImports`, `addUnionImports`) so the async funcIdxs can never drift
 * out of lockstep depending on which import path fired. Inert unless the native
 * async carrier actually emitted these helpers (all fields stay `-1` otherwise,
 * so `v >= importsBefore` is false → no-op → byte-identical on the off-carrier
 * gc/host + standalone lanes).
 */
export function shiftAsyncSideChannelFuncIdxs(ctx: CodegenContext, importsBefore: number, added: number): void {
  if (added <= 0) return;
  const sched = (ctx as unknown as { asyncScheduler?: Record<string, number> }).asyncScheduler;
  if (sched) {
    for (const k of ASYNC_SCHEDULER_FUNC_IDX_KEYS) {
      const v = sched[k];
      if (typeof v === "number" && inLiveShiftRange(v, importsBefore)) sched[k] = v + added;
    }
  }
  const comb = (ctx as unknown as { __promiseCombinators?: Record<string, number> }).__promiseCombinators;
  if (comb) {
    for (const k of COMBINATOR_FUNC_IDX_KEYS) {
      const v = comb[k];
      if (typeof v === "number" && inLiveShiftRange(v, importsBefore)) comb[k] = v + added;
    }
  }
}
