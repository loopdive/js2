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
//   1C-A (this PR): microtask queue (WasmGC funcref+externref arrays) +
//                   __microtask_enqueue / __drain_microtasks helpers +
//                   __drain_microtasks export + WASI _start auto-drain
//   1C-B (future ): Promise.then standalone — synthesised continuation
//                   wrappers, chained-resolution machinery, rejection
//                   propagation. Deferred because it requires careful
//                   interaction with the GC closure infrastructure (see
//                   issue #1326c "Why this is harder than spec estimated").
//
// Phase 1C-A is intentionally a no-op from the user's perspective: nothing
// calls `emitMicrotaskEnqueue` yet. The drain export + _start hook are
// inert until Phase 1C-B wires `.then` to enqueue continuations. Shipping
// the infrastructure separately keeps the surface area reviewable and the
// regression risk near zero.

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { addFuncType, getOrRegisterArrayType } from "./registry/types.js";

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
 *   - callbacks: externref (Phase 1C-A placeholder; Phase 1C-B will upgrade
 *     to a typed pending-continuation linked list once .then chaining
 *     against PENDING promises is implemented)
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
      // Phase 1A placeholder. Phase 1C-B replaces with a typed pending-
      // continuation linked list once `.then` against a still-PENDING
      // promise needs to defer its continuation until resolve fires.
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
    { op: "ref.null", typeIdx: 0 } as unknown as Instr, // ref.null func — placeholder; emitted as `ref.null func` by the binary writer when elem is funcref
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
    } as unknown as Instr,

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
    } as unknown as Instr,

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
    } as unknown as Instr,

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
    } as unknown as Instr,

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

/**
 * #1326 Phase 1C-A — Compile a call to `__microtask_enqueue(fn, caps, arg)`
 * into the caller's body. Caller-supplied `funcRefInstrs` push a funcref;
 * `capsInstrs` push an externref carrying any closure-state captures the
 * drain-time callback will need; `argInstrs` push the externref value to
 * pass to the callback.
 *
 * Phase 1C-A has no in-tree caller yet — `.then` integration is Phase 1C-B.
 * Exposed so callers can wire microtask scheduling once the wrapper-
 * synthesis pipeline is in place.
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

/**
 * #1326 Phase 1C-B stub — emit standalone-mode `promise.then(fn)`.
 *
 * Not implemented in 1C-A (this PR). The chained-resolution machinery
 * requires synthesised continuation wrappers that close over both the user
 * closure struct AND a new pending `$Promise`, which interacts in non-
 * trivial ways with the existing GC closure pipeline. Phase 1C-A ships
 * the queue infrastructure + drain export so 1C-B can plug `.then` in
 * incrementally on top of a known-stable foundation.
 */
export function emitStandalonePromiseThen(
  _ctx: CodegenContext,
  _fctx: FunctionContext,
  _promiseInstrs: Instr[],
  _fnInstrs: Instr[],
): void {
  throw new Error(
    "#1326 Phase 1C-B: emitStandalonePromiseThen not yet implemented — Phase 1C-A shipped the queue + drain infrastructure; .then standalone wiring follows in a separate PR",
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
