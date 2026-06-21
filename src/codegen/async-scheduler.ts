// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1326 Phase 1A — Async standalone microtask queue + Promise GC struct.
// #1326 Phase 1C-A — Microtask queue infrastructure + drain export.
//
// This module provides the foundation for running Promise/async code in
// standalone (WASI) mode without JS-host imports. The full Phase 1 is
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
import { addUnionImportsViaRegistry } from "./shared.js";

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
  /** Counter for generated `__then_fulfill_N` / `__then_reject_N` wrappers. */
  thenWrapperCounter: number;
  /** Whether `__drain_microtasks` has been added to the module's exports. */
  drainExported: boolean;
}

function getOrInitState(ctx: CodegenContextWithScheduler): AsyncSchedulerState {
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
      thenWrapperCounter: 0,
      drainExported: false,
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
type CodegenContextWithScheduler = CodegenContext & { asyncScheduler?: AsyncSchedulerState };

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
    init: [{ op: "ref.null", typeIdx: funcArrIdx } as Instr],
  });
  state.microtaskCapsGlobalIdx = baseGlobalIdx + 4;
  ctx.mod.globals.push({
    name: "__mt_caps",
    type: { kind: "ref_null", typeIdx: argsArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: argsArrIdx } as Instr],
  });
  state.microtaskArgsGlobalIdx = baseGlobalIdx + 5;
  ctx.mod.globals.push({
    name: "__mt_args",
    type: { kind: "ref_null", typeIdx: argsArrIdx },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: argsArrIdx } as Instr],
  });

  // 3. Helper function bodies. Index assignment matches push order — keep
  //    the order grow → enqueue → drain so each later body can reference
  //    the prior ones.
  const baseFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  state.growFuncIdx = baseFuncIdx;
  ctx.mod.functions.push({
    name: "__microtask_grow",
    typeIdx: addFuncType(ctx, [{ kind: "i32" }], [], "$__mt_grow_type"),
    locals: buildGrowLocals(funcArrIdx, argsArrIdx),
    body: buildGrowBody(state, funcArrIdx, argsArrIdx),
    exported: false,
  });
  ctx.funcMap.set("__microtask_grow", state.growFuncIdx);

  state.enqueueFuncIdx = baseFuncIdx + 1;
  ctx.mod.functions.push({
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

  state.drainFuncIdx = baseFuncIdx + 2;
  ctx.mod.functions.push({
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
    { op: "global.get", index: state.microtaskFuncsGlobalIdx } as Instr,
    { op: "local.set", index: oldFuncs },
    { op: "global.get", index: state.microtaskCapsGlobalIdx } as Instr,
    { op: "local.set", index: oldCaps },
    { op: "global.get", index: state.microtaskArgsGlobalIdx } as Instr,
    { op: "local.set", index: oldArgs },
    { op: "global.get", index: state.microtaskHeadGlobalIdx } as Instr,
    { op: "local.set", index: oldHead },
    { op: "global.get", index: state.microtaskTailGlobalIdx } as Instr,
    { op: "local.set", index: oldTail },

    // Allocate the new arrays with init = ref.null.
    // funcs: array.new (default=null funcref) of $newCap.
    { op: "ref.null.func" } as Instr,
    { op: "local.get", index: newCapLocal },
    { op: "array.new", typeIdx: funcArrIdx },
    { op: "global.set", index: state.microtaskFuncsGlobalIdx } as Instr,

    { op: "ref.null.extern" },
    { op: "local.get", index: newCapLocal },
    { op: "array.new", typeIdx: argsArrIdx },
    { op: "global.set", index: state.microtaskCapsGlobalIdx } as Instr,

    { op: "ref.null.extern" },
    { op: "local.get", index: newCapLocal },
    { op: "array.new", typeIdx: argsArrIdx },
    { op: "global.set", index: state.microtaskArgsGlobalIdx } as Instr,

    // If oldFuncs is null, no live entries to copy. Just reset head/tail
    // pointers and capacity, then return.
    { op: "local.get", index: oldFuncs },
    { op: "ref.is_null" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "i32.const", value: 0 },
        { op: "global.set", index: state.microtaskHeadGlobalIdx } as Instr,
        { op: "i32.const", value: 0 },
        { op: "global.set", index: state.microtaskTailGlobalIdx } as Instr,
        { op: "local.get", index: newCapLocal },
        { op: "global.set", index: state.microtaskCapGlobalIdx } as Instr,
        { op: "return" } as Instr,
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
            { op: "i32.eq" } as Instr,
            // depth 1: exit the enclosing block (skip the loop label).
            { op: "br_if", depth: 1 },

            // funcs[dst] = oldFuncs[i]
            { op: "global.get", index: state.microtaskFuncsGlobalIdx } as Instr,
            { op: "local.get", index: dst },
            { op: "local.get", index: oldFuncs },
            { op: "ref.as_non_null" } as Instr,
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: funcArrIdx },
            { op: "array.set", typeIdx: funcArrIdx },

            // caps[dst] = oldCaps[i]
            { op: "global.get", index: state.microtaskCapsGlobalIdx } as Instr,
            { op: "local.get", index: dst },
            { op: "local.get", index: oldCaps },
            { op: "ref.as_non_null" } as Instr,
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: argsArrIdx },
            { op: "array.set", typeIdx: argsArrIdx },

            // args[dst] = oldArgs[i]
            { op: "global.get", index: state.microtaskArgsGlobalIdx } as Instr,
            { op: "local.get", index: dst },
            { op: "local.get", index: oldArgs },
            { op: "ref.as_non_null" } as Instr,
            { op: "local.get", index: i },
            { op: "array.get", typeIdx: argsArrIdx },
            { op: "array.set", typeIdx: argsArrIdx },

            // i++, dst++
            { op: "local.get", index: i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" } as Instr,
            { op: "local.set", index: i },
            { op: "local.get", index: dst },
            { op: "i32.const", value: 1 },
            { op: "i32.add" } as Instr,
            { op: "local.set", index: dst },
            // depth 0: re-enter the loop label.
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // Finalise head/tail/cap.
    { op: "i32.const", value: 0 },
    { op: "global.set", index: state.microtaskHeadGlobalIdx } as Instr,
    { op: "local.get", index: dst },
    { op: "global.set", index: state.microtaskTailGlobalIdx } as Instr,
    { op: "local.get", index: newCapLocal },
    { op: "global.set", index: state.microtaskCapGlobalIdx } as Instr,
  ];
}

function buildEnqueueBody(state: AsyncSchedulerState, funcArrIdx: number, argsArrIdx: number): Instr[] {
  const fnLocal = 0;
  const capsLocal = 1;
  const argLocal = 2;

  return [
    // Lazy first-allocate. Test `funcs` against null.
    { op: "global.get", index: state.microtaskFuncsGlobalIdx } as Instr,
    { op: "ref.is_null" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "i32.const", value: MICROTASK_QUEUE_INITIAL_SLOTS },
        { op: "call", funcIdx: state.growFuncIdx },
      ],
    },

    // If tail == cap, double the queue.
    { op: "global.get", index: state.microtaskTailGlobalIdx } as Instr,
    { op: "global.get", index: state.microtaskCapGlobalIdx } as Instr,
    { op: "i32.eq" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [
        { op: "global.get", index: state.microtaskCapGlobalIdx } as Instr,
        { op: "i32.const", value: 1 },
        { op: "i32.shl" } as Instr,
        { op: "call", funcIdx: state.growFuncIdx },
      ],
    },

    // Store fn, caps, arg at index `tail`.
    { op: "global.get", index: state.microtaskFuncsGlobalIdx } as Instr,
    { op: "ref.as_non_null" } as Instr,
    { op: "global.get", index: state.microtaskTailGlobalIdx } as Instr,
    { op: "local.get", index: fnLocal },
    { op: "array.set", typeIdx: funcArrIdx },

    { op: "global.get", index: state.microtaskCapsGlobalIdx } as Instr,
    { op: "ref.as_non_null" } as Instr,
    { op: "global.get", index: state.microtaskTailGlobalIdx } as Instr,
    { op: "local.get", index: capsLocal },
    { op: "array.set", typeIdx: argsArrIdx },

    { op: "global.get", index: state.microtaskArgsGlobalIdx } as Instr,
    { op: "ref.as_non_null" } as Instr,
    { op: "global.get", index: state.microtaskTailGlobalIdx } as Instr,
    { op: "local.get", index: argLocal },
    { op: "array.set", typeIdx: argsArrIdx },

    // tail++
    { op: "global.get", index: state.microtaskTailGlobalIdx } as Instr,
    { op: "i32.const", value: 1 },
    { op: "i32.add" } as Instr,
    { op: "global.set", index: state.microtaskTailGlobalIdx } as Instr,
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
    { op: "global.get", index: state.microtaskFuncsGlobalIdx } as Instr,
    { op: "ref.is_null" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" } as any,
      then: [{ op: "return" } as Instr],
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
            { op: "global.get", index: state.microtaskHeadGlobalIdx } as Instr,
            { op: "global.get", index: state.microtaskTailGlobalIdx } as Instr,
            { op: "i32.eq" } as Instr,
            // depth 1: exit the enclosing block (skip the loop label).
            { op: "br_if", depth: 1 },

            // Read fn, caps, arg at head.
            { op: "global.get", index: state.microtaskFuncsGlobalIdx } as Instr,
            { op: "ref.as_non_null" } as Instr,
            { op: "global.get", index: state.microtaskHeadGlobalIdx } as Instr,
            { op: "array.get", typeIdx: funcArrIdx },
            { op: "local.set", index: fnLocal },

            { op: "global.get", index: state.microtaskCapsGlobalIdx } as Instr,
            { op: "ref.as_non_null" } as Instr,
            { op: "global.get", index: state.microtaskHeadGlobalIdx } as Instr,
            { op: "array.get", typeIdx: argsArrIdx },
            { op: "local.set", index: capsLocal },

            { op: "global.get", index: state.microtaskArgsGlobalIdx } as Instr,
            { op: "ref.as_non_null" } as Instr,
            { op: "global.get", index: state.microtaskHeadGlobalIdx } as Instr,
            { op: "array.get", typeIdx: argsArrIdx },
            { op: "local.set", index: argLocal },

            // head++ (advance BEFORE the call so a callback that enqueues
            // more entries doesn't have to worry about an unconsumed slot).
            { op: "global.get", index: state.microtaskHeadGlobalIdx } as Instr,
            { op: "i32.const", value: 1 },
            { op: "i32.add" } as Instr,
            { op: "global.set", index: state.microtaskHeadGlobalIdx } as Instr,

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

function ensurePromiseSettleFunctions(ctx: CodegenContext): void {
  ensureMicrotaskQueue(ctx);
  const state = getOrInitState(ctx as CodegenContextWithScheduler);
  if (state.promiseFulfillFuncIdx !== -1) return;

  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  const callbackTypeIdx = getOrRegisterPromiseCallbackType(ctx);
  const capsTypeIdx = getOrRegisterThenCapsType(ctx);
  const settleTypeIdx = addFuncType(
    ctx,
    [{ kind: "ref", typeIdx: promiseTypeIdx }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$__promise_settle_type",
  );

  const baseFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  state.promiseFulfillFuncIdx = baseFuncIdx;
  state.promiseRejectFuncIdx = baseFuncIdx + 1;
  state.identityFulfillWrapperFuncIdx = baseFuncIdx + 2;
  state.identityRejectWrapperFuncIdx = baseFuncIdx + 3;

  ctx.mod.functions.push({
    name: "__promise_fulfill",
    typeIdx: settleTypeIdx,
    locals: buildPromiseSettleLocals(callbackTypeIdx),
    body: buildPromiseSettleBody(state, promiseTypeIdx, callbackTypeIdx, PROMISE_STATE_FULFILLED),
    exported: false,
  });
  ctx.funcMap.set("__promise_fulfill", state.promiseFulfillFuncIdx);

  ctx.mod.functions.push({
    name: "__promise_reject",
    typeIdx: settleTypeIdx,
    locals: buildPromiseSettleLocals(callbackTypeIdx),
    body: buildPromiseSettleBody(state, promiseTypeIdx, callbackTypeIdx, PROMISE_STATE_REJECTED),
    exported: false,
  });
  ctx.funcMap.set("__promise_reject", state.promiseRejectFuncIdx);

  ctx.mod.functions.push({
    name: "__then_identity_fulfill",
    typeIdx: state.microtaskFuncTypeIdx,
    locals: buildIdentityWrapperLocals(capsTypeIdx),
    body: buildIdentityWrapperBody(capsTypeIdx, state.promiseFulfillFuncIdx),
    exported: false,
  });
  ctx.funcMap.set("__then_identity_fulfill", state.identityFulfillWrapperFuncIdx);

  ctx.mod.functions.push({
    name: "__then_identity_reject",
    typeIdx: state.microtaskFuncTypeIdx,
    locals: buildIdentityWrapperLocals(capsTypeIdx),
    body: buildIdentityWrapperBody(capsTypeIdx, state.promiseRejectFuncIdx),
    exported: false,
  });
  ctx.funcMap.set("__then_identity_reject", state.identityRejectWrapperFuncIdx);
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
    } as Instr,

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
    } as Instr,

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
      body.push({ op: "ref.null", typeIdx: type.typeIdx }, { op: "ref.as_non_null" } as Instr);
      return;
    case "ref_null":
      body.push({ op: "ref.null", typeIdx: type.typeIdx });
      return;
    case "funcref":
      body.push({ op: "ref.null.func" } as Instr);
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
      body.push({ op: "any.convert_extern" }, { op: "ref.cast", typeIdx: type.typeIdx } as Instr);
      return;
    case "ref_null":
      body.push({ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: type.typeIdx } as Instr);
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
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;

  const locals: LocalDef[] = [
    { name: "$caps", type: { kind: "ref", typeIdx: capsTypeIdx } },
    { name: "$callback", type: { kind: "ref", typeIdx: info.structTypeIdx } },
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
    { op: "ref.cast", typeIdx: info.structTypeIdx },
    { op: "local.set", index: callbackLocal },

    // call_ref stack shape: [closure_self, ...user_args, typed_funcref]
    { op: "local.get", index: callbackLocal },
  ];

  for (let i = 0; i < info.paramTypes.length; i++) {
    if (i === 0) {
      pushExternrefLocalAsType(ctx, body, 1, info.paramTypes[i]!);
    } else {
      pushDefaultForType(body, info.paramTypes[i]!);
    }
  }

  body.push(
    { op: "local.get", index: callbackLocal },
    { op: "struct.get", typeIdx: info.structTypeIdx, fieldIdx: 0 } as Instr,
    { op: "ref.cast", typeIdx: info.funcTypeIdx } as Instr,
    { op: "call_ref", typeIdx: info.funcTypeIdx },
  );
  coerceStackValueToExternref(ctx, body, info.returnType);
  body.push(
    { op: "local.set", index: resultLocal },
    { op: "local.get", index: capLocal },
    { op: "struct.get", typeIdx: capsTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.get", index: resultLocal },
    { op: "call", funcIdx: settleFuncIdx },
  );

  ctx.mod.functions.push({
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
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_FULFILLED });
  for (const instr of valueInstrs) fctx.body.push(instr);
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "extern.convert_any" });
}

/**
 * #1326 Phase 1B — emit standalone-mode `Promise.reject(reason)` as a
 * Wasm-native `$Promise` GC struct construction. Symmetric to
 * `emitStandalonePromiseResolve` but with `state = REJECTED`.
 */
export function emitStandalonePromiseReject(ctx: CodegenContext, fctx: FunctionContext, reasonInstrs: Instr[]): void {
  const promiseTypeIdx = getOrRegisterPromiseType(ctx);
  fctx.body.push({ op: "i32.const", value: PROMISE_STATE_REJECTED });
  for (const instr of reasonInstrs) fctx.body.push(instr);
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "struct.new", typeIdx: promiseTypeIdx });
  fctx.body.push({ op: "extern.convert_any" });
}

export interface StandalonePromiseThenCallback {
  instrs: Instr[];
  closureInfo: ClosureInfo;
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

  const fulfillWrapperFuncIdx = onFulfilled
    ? emitThenWrapperFunction(ctx, onFulfilled.closureInfo, state.promiseFulfillFuncIdx, "__then_fulfill")
    : state.identityFulfillWrapperFuncIdx;
  const rejectWrapperFuncIdx = onRejected
    ? emitThenWrapperFunction(ctx, onRejected.closureInfo, state.promiseFulfillFuncIdx, "__then_reject")
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
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 } as Instr,
    { op: "i32.const", value: PROMISE_STATE_FULFILLED },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "ref.func", funcIdx: fulfillWrapperFuncIdx },
        { op: "local.get", index: fulfilledCapsLocal },
        { op: "local.get", index: promiseLocal },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 } as Instr,
        { op: "call", funcIdx: state.enqueueFuncIdx },
      ],
      else: [
        { op: "local.get", index: promiseLocal },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 } as Instr,
        { op: "i32.const", value: PROMISE_STATE_REJECTED },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "ref.func", funcIdx: rejectWrapperFuncIdx },
            { op: "local.get", index: rejectedCapsLocal },
            { op: "local.get", index: promiseLocal },
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 } as Instr,
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
            { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 2 } as Instr,
            { op: "struct.new", typeIdx: callbackTypeIdx } as Instr,
            { op: "extern.convert_any" } as Instr,
            { op: "struct.set", typeIdx: promiseTypeIdx, fieldIdx: 2 } as Instr,
          ],
        } as Instr,
      ],
    } as Instr,
    { op: "local.get", index: chainedLocal },
    { op: "extern.convert_any" } as Instr,
  );
}

/**
 * #1326 — Check whether standalone-mode Promise codegen is active.
 * Auto-enables in WASI target mode (the JS host imports for Promise are
 * unavailable); opt-in elsewhere via a flag.
 */
export function isStandalonePromiseActive(ctx: CodegenContext): boolean {
  return ctx.wasi === true;
}
